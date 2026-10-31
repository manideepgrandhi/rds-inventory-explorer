# baseline.jq - checks every parameter row against the baseline rules (parameters.baseline), at report build time.
# Usage: jq --argjson bl '{file, sha256, rules: [...]}|null' -f baseline.jq model.json   (after parameters.jq, before insights.jq)
# Status per rule: pass | fail | missing (parameter exists, no value) | n/a (engine version has no such parameter); n/a is left out on cluster rows (members carry it)
#                  | unknown (value cannot be compared, or the parameter was not collected)
# Aurora PostgreSQL is checked once per cluster, against the cluster parameter group's effective value only
# (user > system > AWS cluster default); a baseline parameter with no value there fails ("not set in cluster parameter group").
# Member rows get no results. A member whose instance group sets a baseline parameter (Source user) to another value
# than the cluster's is listed in the cluster's .bl.overrides (a note, never a failure).
# Global clusters: each baseline parameter's cluster-level value is compared between the primary and its secondaries
# (normalised like the checks: contains lists as case-insensitive sets); a difference is .xr on the result (a flag, not a failure);
# a member region missing from the scan/merge is a note in .bl.xr_notes ("secondary in <region> not scanned").
# Adds .parameters.rows[].bl = {results, high, medium, low, dev, members: {high, medium, low, dev, resources}} and
# .baseline = {applied, file, sha256, sha_short, rules, reason, accounts, totals, csv}.
def trim: sub("^[ \t]+"; "") | sub("[ \t]+$"; "");
def lc: ascii_downcase | trim;
def bool: lc | if test("^(1|on|true|yes)$") then "1" elif test("^(0|off|false|no)$") then "0" else null end;
def num: if type == "number" then . elif type == "string" and (trim | test("^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$")) then trim | tonumber else null end;
def items: if . == null then [] else split(",") | map(lc | select(. != "" and . != "''")) end;
# postgres (legacy, pre-2.4.0) = RDS + Aurora PostgreSQL; rds-postgres / aurora-postgresql = one of them; mysql = RDS + Aurora MySQL
def fam_match($sec): . as $f | if $f == "postgres" then ($sec == "rds-postgres" or $sec == "aurora-postgresql")
    elif $f == "mysql" then ($sec == "mysql" or $sec == "aurora-mysql") else $f == $sec end;
def major: (. // "") | (capture("^(?<m>[0-9]+)") | .m | tonumber) // null;
# PostgreSQL 18+ log_connections is a list of stages; "1" when on / all / receipt+authentication+authorization
def pg18_logconn: (lc) as $v | if ($v | bool) then ($v | bool) elif $v == "all" then "1" elif $v == "" or $v == "''" then "0"
    else ($v | items) as $i | if (["receipt", "authentication", "authorization"] - $i | length) == 0 then "1" else "partial" end end;
# eq($a; $e): a value equals an expected one (booleans, numbers, then case-insensitive text)
def eq($a; $e): if ($a | bool) != null and ($e | bool) != null then ($a | bool) == ($e | bool)
    elif ($a | num) != null and ($e | num) != null then ($a | num) == ($e | num) else ($a | lc) == ($e | lc) end;

def judge($r; $val; $approx):   # -> {status, approx}
    ($val // "") as $a
    | if $r.rule == "set" then {status: (if ($a | trim) == "" then "fail" else "pass" end)}
      elif ($a | trim) == "" then {status: "missing"}
      elif ($r.rule | test("^[<>]=?$|^between$")) then
        (($a | num) // $approx) as $n | ($a | num | not) as $ap
        | if $n == null then {status: "unknown", why: "not a number"}
          else ($r.value | if $r.rule == "between" then capture("^(?<a>-?[0-9.]+)-(?<b>-?[0-9.]+)$") | [(.a | tonumber), (.b | tonumber)] else [tonumber] end) as $x
          | {status: (if ({">": ($n > $x[0]), ">=": ($n >= $x[0]), "<": ($n < $x[0]), "<=": ($n <= $x[0]),
                           "between": ($n >= $x[0] and $n <= ($x[1] // $x[0]))}[$r.rule]) then "pass" else "fail" end),
             approx: (if $ap then $n else null end)} end
      elif ($a | test("^\\{")) then {status: "unknown", why: "formula"}
      elif $r.rule == "=" then {status: (if eq($a; $r.value) then "pass" else "fail" end)}
      elif $r.rule == "!=" then {status: (if eq($a; $r.value) then "fail" else "pass" end)}
      elif $r.rule == "in" then {status: (if any($r.value | split(",")[] | trim; eq($a; .)) then "pass" else "fail" end)}
      elif $r.rule == "contains" then ($a | items) as $i | {status: (if ($r.value | items) - $i | length == 0 then "pass" else "fail" end),
                                                            why: (($r.value | items) - $i | if length > 0 then "lacks " + join(",") else null end)}
      elif $r.rule == "!contains" then ($a | items) as $i | ([($r.value | items)[] | select(. as $x | $i | index([$x]))]) as $bad
                                      | {status: (if $bad == [] then "pass" else "fail" end), why: (if $bad == [] then null else "has " + ($bad | join(",")) end)}
      else {status: "unknown"} end;

# expected rule as words (no leading = so a spreadsheet never reads it as a formula)
def expect($r): {"=": "is", "!=": "is not", "in": "one of", "contains": "contains", "!contains": "excludes", ">": ">", ">=": ">=", "<": "<", "<=": "<=", "between": "between"}[$r.rule] as $w
    | if $r.rule == "set" then "set (any value)" elif $r.rule == "between" then ($r.value | capture("^(?<a>-?[0-9.]+)-(?<b>-?[0-9.]+)$") | "between \(.a) and \(.b)") else "\($w) \($r.value)" end;
def SEVN: {"high": 0, "medium": 1, "low": 2};

($bl[0] // null) as $BL
| (.parameters // {collected: false}) as $P
| if $BL == null then .baseline = {applied: false, reason: "off", rules: 0}
  elif ($P.collected | not) then .baseline = {applied: false, reason: "parameters not collected (add --with-parameters)", file: $BL.file,
                                               sha256: $BL.sha256, sha_short: ($BL.sha256[0:12]), rules: ($BL.rules | length)}
  else
    (reduce .resources[] as $x ({}; .[$x.id] = ($x.version // ""))) as $VER
    | ($P.list // {}) as $LIST
    | def apg: .section == "aurora-postgresql";
      def norm: (. // "") | lc;
    # Aurora PostgreSQL members by cluster: instance-group overrides
    ([.parameters.rows[] | select(apg and .type == "member" and .cluster_id != null)] | group_by(.cluster_id)
       | map({key: .[0].cluster_id, value: .}) | from_entries) as $APGM
    | ([$BL.rules[] | select(.family | fam_match("aurora-postgresql")) | .param] | unique) as $APGP
    | .parameters.rows |= map(. as $row | ($VER[$row.res_id] // "") as $ver
        | (if ($row | apg) and $row.type == "cluster" then ($APGM[$row.res_id] // []) else [] end) as $mem
        | ([$APGP[] as $p | ($row.values[$p] // null) as $cv | select($cv != null) | $mem[] | . as $m | ($m.values[$p] // null) as $iv
            | select($iv != null and $iv.from == "instance" and $iv.src == "user" and ($iv.v | norm) != ($cv.v | norm))
            | {param: $p, instance: $m.name, res_id: $m.res_id, value: ($iv.v // ""), cluster_value: ($cv.v // ""),
               group: (($iv.group // "") | split("|") | last)}]) as $ovr
        | [$BL.rules[] | select(.family | fam_match($row.section)) | select(($row | apg | not) or $row.type != "member" or $row.cluster_id == null) | . as $r
           | ($row.values[$r.param] // null) as $pv
           | (if $pv != null then
                (if $r.param == "log_connections" and ($row.section | test("postgres")) and (($ver | major) // 0) >= 18 and ($r.rule == "=" or $r.rule == "!=")
                 then ($pv.v // "") as $raw | ($raw | pg18_logconn) as $nv
                   | judge($r; (if $nv == "partial" then $raw else $nv end); null)
                   | if $nv == "partial" and .status == "fail" then .why = "PG18+ needs receipt,authentication,authorization or all" else . end
                 else judge($r; $pv.v; $pv.approx) end)
                | if ($row | apg) and $row.type == "cluster" and (.status == "missing" or ($r.rule == "set" and .status == "fail"))
                  then {status: "fail", why: "not set in cluster parameter group"} else . end
              elif $row.group_error then {status: "unknown", why: "parameter group not readable"}
              elif (($LIST[$row.section] // []) | index([$r.param])) == null then {status: "unknown", why: "not collected (data saved without this parameter)"}
              # no value in the cluster group: a failure, unless no member knows the parameter either (not in this engine version)
              elif ($row | apg) and $row.type == "cluster" and ($mem == [] or any($mem[]; .values[$r.param] != null))
                then {status: "fail", why: "not set in cluster parameter group"}
              elif (($LIST[$row.section] // []) | index([$r.param])) == null then {status: "unknown", why: "not collected (data saved without this parameter)"}
              else {status: "n/a", why: "not a parameter of this engine version"} end) as $j
           | {param: $r.param, rule: $r.rule, value: $r.value, expected: expect($r), sev: $r.sev, line: $r.line,
              actual: ($pv.v // null), from: ($pv.from // null), group: (($pv.group // "") | split("|") | last | if . == "" then null else . end),
              status: $j.status, approx: ($j.approx // null), why: ($j.why // null),
              overrides: ([$ovr[] | select(.param == $r.param) | {instance, res_id, value}] | if length > 0 then . else null end)}
           | with_entries(select(.key != "overrides" or .value != null))
           # an Aurora MySQL cluster group lacks the instance-level parameters: those are checked on the members, not n/a here
           | select($row.type != "cluster" or ($row | apg) or .status != "n/a")] as $res
        | ([$res[] | select(.status == "fail" or .status == "missing")]) as $dev
        | . + {version: $ver, bl: {results: $res, high: ([$dev[] | select(.sev == "high")] | length),
               medium: ([$dev[] | select(.sev == "medium")] | length), low: ([$dev[] | select(.sev == "low")] | length), dev: ($dev | length),
               overrides: $ovr, overridden: ($ovr | map(.instance) | unique | length)}})
    # global clusters: compare every baseline parameter's cluster-level value between the primary and the secondaries
    | def cmpv($r): (.v // null) as $v | if $v == null or ($v | trim) == "" then "(not set)"
          elif ($r.rule == "contains" or $r.rule == "!contains") then ($v | items | unique | join(","))
          elif ($v | bool) != null then ($v | bool) elif ($v | num) != null then ($v | num | tostring) else ($v | lc) end;
      def shown: (.v // null) | if . == null or (trim == "") then "(not set)" else . end;
    ([.resources[] | select(.type == "global")]) as $GL
    | ([.parameters.rows[] | select(.type == "cluster") | {key: .res_id, value: .}] | from_entries) as $CR
    | ([.resources[] | {key: .id, value: true}] | from_entries) as $SCN
    | .parameters.rows |= map(. as $row
        | ([$GL[] | select(any(.d.members[]; .id != null and .id == $row.res_id))][0] // null) as $g
        | if $row.type != "cluster" or $g == null then . else
            ([$g.d.members[] | select(.id == $row.res_id)][0].role) as $role
            | ($g.d.members | map(select(.role == "primary"))[0] // null) as $pm
            | (if $role == "primary" then [$g.d.members[] | select(.role != "primary")] else [$pm | select(. != null)] end) as $peers
            | ([$peers[] | . as $m | select(($m.id == null) or ($CR[$m.id] == null))
                | (if $m.role == "primary" then "primary" else "secondary" end) as $w
                | if $m.id == null or ($SCN[$m.id] | not) then "\($w) in \($m.region) not scanned" else "\($w) \($m.name) (\($m.region)): parameters not collected" end]) as $notes
            | .bl.results |= map(. as $b | ($row.values[$b.param] // {}) as $mine
                | [$peers[] | select(.id != null and $CR[.id] != null) | . as $m | ($CR[$m.id].values[$b.param] // {}) as $their
                   | select(($mine | cmpv($b)) != ($their | cmpv($b)))
                   | if $m.role == "primary" then "differs from primary \($m.name) (\($m.region)): \($mine | shown) here vs \($their | shown)"
                     else "differs on secondary \($m.name) (\($m.region)): \($mine | shown) here vs \($their | shown)" end] as $d
                | if $d == [] then . else . + {xr: ($d | join("; "))} end)
            | .bl.xr = ([.bl.results[] | select(.xr)] | length) | .bl.xr_notes = $notes
          end)
    | (.parameters.rows | map(select(.type == "member" and .cluster_id != null)) | group_by(.cluster_id)
       | map({key: .[0].cluster_id, value: {high: (map(.bl.high) | add), medium: (map(.bl.medium) | add), low: (map(.bl.low) | add),
                                            dev: (map(.bl.dev) | add), resources: (map(select(.bl.dev > 0)) | length)}}) | from_entries) as $MEM
    | .parameters.rows |= map(if .type == "cluster" then .bl.members = ($MEM[.res_id] // {high: 0, medium: 0, low: 0, dev: 0, resources: 0}) else . end)
    | .parameters.rows as $R
    | .baseline = {applied: true, legacy_postgres: any($BL.rules[]; .family == "postgres"), file: $BL.file, sha256: $BL.sha256, sha_short: ($BL.sha256[0:12]), rules: ($BL.rules | length),
        rule_list: $BL.rules,
        totals: {resources: ($R | map(select(.bl.results | length > 0)) | length), off: ($R | map(select(.bl.dev > 0)) | length),
                 high: ($R | map(.bl.high) | add // 0), medium: ($R | map(.bl.medium) | add // 0), low: ($R | map(.bl.low) | add // 0),
                 overridden: ($R | map(select(.bl.overridden > 0)) | length),
                 xregion: ($R | map(select((.bl.xr // 0) > 0)) | length),
                 xregion_globals: ($R | map(select((.bl.xr // 0) > 0) | .global) | unique | length)},
        accounts: [$R | group_by(.account)[] | {account: .[0].account, resources: (map(select(.bl.results | length > 0)) | length),
                     off: (map(select(.bl.dev > 0)) | length), high: (map(.bl.high) | add), medium: (map(.bl.medium) | add), low: (map(.bl.low) | add)}],
        csv: [$R[] | . as $r | .bl.results[] | [$r.account, $r.region, $r.name, $r.type, ($r.cluster_name // ""), $r.engine, $r.version,
               .param, .expected, ((.actual // "") + (if .approx != null then " (\u2248 \(.approx))" else "" end)), (.group // ""), .status, .sev,
               ([(.overrides // [])[] | "\(.instance)=\(.value)"] | join("; ")), ($r.global // ""), ($r.global_role // ""), (.xr // "")]]}
    | .meta.csv_columns.baseline = ["Account", "Region", "Resource", "Resource type", "Cluster", "Engine", "Version", "Parameter",
                                    "Expected rule", "Actual", "Source group", "Status", "Severity", "Overridden on (instance=value)",
                                    "Global cluster", "Global role", "Cross-region mismatch"]
  end
