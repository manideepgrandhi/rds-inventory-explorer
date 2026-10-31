# parameters.jq - the Parameters tab data, from the parameter data --with-parameters keeps in each region block.
# Usage: jq --slurpfile raw raw.json -f parameters.jq model.json   (runs after explorer.jq, before insights.jq)
# Raw per region: .params = {collected, list: {section: [names]}, groups: [{kind, name, family, user, system, error}],
#                           defaults: [{kind, family, parameters, error}], elapsed_ms}
# Effective value: user > system > engine default. A cluster member uses its instance group's value when the
# instance group sets it (Source user or system), else the cluster group's, else the engine default.
# Adds .parameters {collected, regions, not_collected, groups, rows, drift, list, notes, elapsed_ms}.

def section: if type != "string" then null
    elif test("^aurora-postgresql") then "aurora-postgresql" elif test("^aurora-mysql|^aurora[0-9.]*$") then "aurora-mysql"
    elif test("^postgres") then "postgres" elif test("^(mysql|mariadb)") then "mysql" elif test("^sqlserver") then "sqlserver"
    elif test("^(custom-)?oracle") then "oracle" else null end;
# approximate DBInstanceClassMemory (GiB) from the class: AWS reserves some memory, so the real value is a bit lower
def class_gib: if type != "string" then null else split(".") as $p
    | if ($p | length) != 3 or $p[0] != "db" then null else ($p[1]) as $f | ($p[2]) as $z
      | ({"micro": 0.5, "small": 1, "medium": 2, "large": 4, "xlarge": 8} [$z]
         // (if ($z | test("^[0-9]+xlarge$")) then ($z | rtrimstr("xlarge") | tonumber) * 8 else null end)) as $u
      | (if $f | test("^t[234]") then {"micro": 1, "small": 2, "medium": 4, "large": 8, "xlarge": 16, "2xlarge": 32}[$z]
         elif $u == null then null
         elif $f | test("^x2") then $u * 8 elif $f | test("^x1") then $u * 7.6 elif $f | test("^(r|z1d)") then $u * 4
         elif $f | test("^m") then $u * 2 elif $f | test("^c") then $u else null end) end end;
def approx($gib): if $gib == null or (type != "string") then null
    else (capture("^\\{DBInstanceClassMemory(?<ops>([*/][0-9]+)*)\\}$") // null) as $c
    | if $c == null then null else
        reduce ($c.ops | [scan("([*/])([0-9]+)")][]) as $o ($gib * 1073741824;
            if $o[0] == "*" then . * ($o[1] | tonumber) else . / ($o[1] | tonumber) end) | floor end end;
def off: (. // "") | ascii_downcase | . == "0" or . == "off" or . == "false";
def flag($n; $sec):
    (.v // "") as $v
    | if $n == "rds.force_ssl" and $v == "0" then "SSL not forced"
      elif $n == "log_connections" and ($v | off) then "connection logging off"
      elif $n == "require_secure_transport" and ($v | off) then "secure transport not required"
      elif ($n == "rds.tls10" or $n == "rds.tls11") and ($v | ascii_downcase) == "enabled" then "\($n | ltrimstr("rds.") | ascii_upcase | sub("TLS1"; "TLS 1.")) enabled"
      elif $n == "password_encryption" and ($v | ascii_downcase) == "md5" then "md5 passwords"
      elif $n == "shared_preload_libraries" and ($sec == "postgres" or $sec == "aurora-postgresql") and ($v | test("pgaudit") | not) then "pgaudit not loaded"
      else null end;
def pv: {v: .ParameterValue, src: .Source, apply: .ApplyType, mod: .IsModifiable, dtype: .DataType, allowed: .AllowedValues};

($raw[0].regions // []) as $REG
| [$REG[] | select(.params != null)] as $PR
| ($PR | map(.params.list) | add // {}) as $LIST
| ([$PR[] | . as $r | .params.groups[] | . as $g
   | (([(.system // [])[] | {key: .Name, value: pv}] | from_entries) + ([(.user // [])[] | {key: .Name, value: pv}] | from_entries)) as $vals
   | {gid: "\($r.account)|\($r.region)|\(.kind)|\(.name)", account: $r.account, region: $r.region, kind, name, family,
      section: (.family | section), is_default: (.name | startswith("default.")), error, values: $vals,
      nondefault: ([$vals[] | select(.src == "user")] | length)}] | unique_by(.gid)) as $G0
| ([$G0[] | {key: .gid, value: .}] | from_entries) as $GI
| ([$PR[] | . as $r | .params.defaults[] | {key: "\($r.account)|\($r.region)|\(.kind)|\(.family)", value: ([(.parameters // [])[] | {key: .Name, value: pv}] | from_entries)}] | from_entries) as $DF
| ([$PR[] | "\(.account)|\(.region)"] | map({key: ., value: true}) | from_entries) as $HAS
| ([.resources[] | select(.type == "cluster") | {key: .id, value: .}] | from_entries) as $CLR
| def gid($r; $kind; $name): if $name == null then null else "\($r.account)|\($r.region)|\($kind)|\($name)" end;
  def dflt($r; $kind; $g): if $g == null or $g.family == null or $g.error != null then {} else ($DF["\($r.account)|\($r.region)|\($kind)|\($g.family)"] // {}) end;
  def cval($r; $cg): ($GI[$cg // ""] // null) as $g | ($g.values // {}) as $gv | dflt($r; "cluster"; $g) as $d
      | ([$gv, $d] | map(keys) | add | unique) as $ks
      | reduce $ks[] as $k ({}; .[$k] = (if $gv[$k] then $gv[$k] + {from: "cluster", group: $cg} else $d[$k] + {from: "default", group: $cg} end));
  def ival($r; $ig): ($GI[$ig // ""] // null) as $g | ($g.values // {}) as $gv | dflt($r; "instance"; $g) as $d
      | ([$gv, $d] | map(keys) | add | unique) as $ks
      | reduce $ks[] as $k ({}; .[$k] = (if $gv[$k] then $gv[$k] + {from: "instance", group: $ig} else $d[$k] + {from: "default", group: $ig} end));
  def finish($r; $sec): ($r.class | class_gib) as $gib
      | with_entries(.key as $n | .value |= (. + {nondef: (.src == "user"), approx: (.v | approx($gib)), flag: flag($n; $sec)}
                                             | with_entries(select(.value != null))))
      | with_entries(select(.key as $n | (($LIST[$sec] // []) | index([$n])) != null));
  [.resources[] | select(.type != "global" and $HAS["\(.account)|\(.region)"] and (.engine | test("^(docdb|neptune)") | not)) | . as $r
   | ($r.engine | section) as $sec
   | if .type == "cluster" then gid($r; "cluster"; $r.d.param_group) as $cg
       | {res_id: .id, name, type, account, region, engine, class, section: $sec, cluster_id: null, global: ($r.d.global.name // null),
          cluster_group: $cg, instance_group: null, apply_status: null, group_error: ($GI[$cg // ""].error // null),
          values: (cval($r; $cg) | finish($r; $sec))}
     else gid($r; "instance"; ($r.d.param_groups[0].name // null)) as $ig
       | (if .type == "member" then $CLR[$r.d.cluster.id // ""] else null end) as $c
       | (if $c then gid($c; "cluster"; $c.d.param_group) else null end) as $cg
       | ([($c.raw.DBClusterMembers // [])[] | select(.DBInstanceIdentifier == $r.name) | .DBClusterParameterGroupStatus][0]) as $cst
       | {res_id: .id, name, type, account, region, engine, class, section: $sec, cluster_id: ($c.id // null), cluster_name: ($c.name // $r.d.cluster.name // null),
          global: ($r.d.global.name // null), cluster_group: $cg, instance_group: $ig,
          apply_status: ($r.d.param_groups[0].status // null), cluster_apply_status: $cst,
          group_error: ([$GI[$ig // ""].error, $GI[$cg // ""].error] | map(select(. != null)) | .[0] // null),
          values: ((if $c then cval($c; $cg) else {} end) as $cv | ival($r; $ig) as $iv
                   | ([$cv, $iv] | map(keys) | add | unique) as $ks
                   | reduce $ks[] as $k ({}; .[$k] = (if ($iv[$k].from // "") == "instance" then $iv[$k]
                                                     elif ($cv[$k].from // "") == "cluster" then $cv[$k]
                                                     else ($iv[$k] // $cv[$k]) end))
                   | finish($r; $sec))}
     end] as $ROWS0
| ($ROWS0 | map(select(.type == "cluster")) | sort_by(.account, .region, .name)) as $RC
| ([$RC[] | . as $c | ., ($ROWS0[] | select(.cluster_id == $c.res_id) | . + {cluster_name: $c.name})]
   + ($ROWS0 | map(select(.type == "instance" or (.type == "member" and .cluster_id == null))) | sort_by(.account, .region, .name))) as $ROWS
| [$G0[] | . as $g | . + {used_by: [$ROWS[] | select(.cluster_group == $g.gid or .instance_group == $g.gid) | {id: .res_id, name, type}]}] as $G
| [$ROWS | map(select(.section != null)) | group_by(.section)[] | .[0].section as $s | . as $rs
   | ($LIST[$s] // [])[] as $p
   | [$rs[] | select(.values[$p] != null) | {v: (.values[$p].v // "(empty)"), id: .res_id, name}] as $vs
   | ($vs | group_by(.v)) as $by
   | select(($by | length) > 1)
   | {section: $s, param: $p, values: [$by[] | {v: .[0].v, resources: map({id, name})}]}] as $DRIFT
| (.meta.accounts // [] | map(.account) | unique) as $ACCTS
| .parameters = {
    collected: (($PR | length) > 0),
    elapsed_ms: ([$PR[] | .params.elapsed_ms // 0] | add // 0),
    regions: [$REG[] | {account, region, collected: (.params != null)}],
    not_collected: [$ACCTS[] as $a | select([$PR[] | select(.account == $a)] | length == 0) | $a],
    list: $LIST, groups: ($G | sort_by(.account, .region, .kind, .name)), rows: $ROWS, drift: $DRIFT,
    notes: ["Oracle: sqlnet encryption / checksum (NATIVE_NETWORK_ENCRYPTION) is set in the option group, not the parameter group; the option group names are shown.",
            "\u2248 values are approximate: DBInstanceClassMemory is estimated from the instance class (AWS reserves part of it); omitted when the class is unknown."]}
| .meta.csv_columns.parameters = ["Account", "Region", "Resource", "Resource type", "Cluster", "Engine", "Parameter", "Value", "Approx. computed",
                                  "Source", "From", "Parameter group", "Non-default", "Flag", "Apply type", "Apply status"]
| .parameters.csv = [$ROWS[] | . as $r | .values | to_entries[] | .key as $n | .value as $v
    | [$r.account, $r.region, $r.name, $r.type, ($r.cluster_name // ""), $r.engine, $n, ($v.v // ""), ($v.approx // "" | tostring),
       ($v.src // ""), ($v.from // ""), ($v.group // "" | split("|") | last), (if $v.nondef then "yes" else "no" end), ($v.flag // ""),
       ($v.apply // ""), ([$r.apply_status, $r.cluster_apply_status] | map(select(. != null)) | join(" / "))]]
