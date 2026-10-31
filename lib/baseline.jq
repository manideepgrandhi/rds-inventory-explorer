# baseline.jq - checks every parameter row against the baseline rules (parameters.baseline), at report build time.
# Usage: jq --argjson bl '{file, sha256, rules: [...]}|null' -f baseline.jq model.json   (after parameters.jq, before insights.jq)
# Status per rule: pass | fail | missing (parameter exists, no value) | n/a (engine version has no such parameter); n/a is left out on cluster rows (members carry it)
#                  | unknown (value cannot be compared, or the parameter was not collected)
#                  | instance-level (Aurora PostgreSQL: an instance-group parameter, not checked; never a failure).
# Aurora PostgreSQL is checked once per cluster, against the cluster parameter group (else the AWS cluster default) only:
# member rows get no results. A member whose instance group sets a baseline parameter (Source user) to another value
# than the cluster's is listed in the cluster's .bl.overrides (a note, never a failure).
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
    # Aurora PostgreSQL members by cluster: instance-level parameter names, and instance-group overrides
    ([.parameters.rows[] | select(apg and .type == "member" and .cluster_id != null)] | group_by(.cluster_id)
       | map({key: .[0].cluster_id, value: .}) | from_entries) as $APGM
    | ([$BL.rules[] | select(.family | fam_match("aurora-postgresql")) | .param] | unique) as $APGP
    | .parameters.rows |= map(. as $row | ($VER[$row.res_id] // "") as $ver
        | (if ($row | apg) and $row.type == "cluster" then ($APGM[$row.res_id] // []) else [] end) as $mem
        | ([$mem[] | .values | keys[]] | unique - ($row.values | keys)) as $ik
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
              elif $row.group_error then {status: "unknown", why: "parameter group not readable"}
              elif ($ik | index([$r.param])) != null then {status: "instance-level", why: "instance-level parameter, not checked (Aurora PostgreSQL is checked on the cluster group)"}
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
    | (.parameters.rows | map(select(.type == "member" and .cluster_id != null)) | group_by(.cluster_id)
       | map({key: .[0].cluster_id, value: {high: (map(.bl.high) | add), medium: (map(.bl.medium) | add), low: (map(.bl.low) | add),
                                            dev: (map(.bl.dev) | add), resources: (map(select(.bl.dev > 0)) | length)}}) | from_entries) as $MEM
    | .parameters.rows |= map(if .type == "cluster" then .bl.members = ($MEM[.res_id] // {high: 0, medium: 0, low: 0, dev: 0, resources: 0}) else . end)
    | .parameters.rows as $R
    | .baseline = {applied: true, legacy_postgres: any($BL.rules[]; .family == "postgres"), file: $BL.file, sha256: $BL.sha256, sha_short: ($BL.sha256[0:12]), rules: ($BL.rules | length),
        rule_list: $BL.rules,
        totals: {resources: ($R | map(select(.bl.results | length > 0)) | length), off: ($R | map(select(.bl.dev > 0)) | length),
                 high: ($R | map(.bl.high) | add // 0), medium: ($R | map(.bl.medium) | add // 0), low: ($R | map(.bl.low) | add // 0),
                 overridden: ($R | map(select(.bl.overridden > 0)) | length)},
        accounts: [$R | group_by(.account)[] | {account: .[0].account, resources: (map(select(.bl.results | length > 0)) | length),
                     off: (map(select(.bl.dev > 0)) | length), high: (map(.bl.high) | add), medium: (map(.bl.medium) | add), low: (map(.bl.low) | add)}],
        csv: [$R[] | . as $r | .bl.results[] | [$r.account, $r.region, $r.name, $r.type, ($r.cluster_name // ""), $r.engine, $r.version,
               .param, .expected, ((.actual // "") + (if .approx != null then " (\u2248 \(.approx))" else "" end)), (.group // ""), .status, .sev,
               ([(.overrides // [])[] | "\(.instance)=\(.value)"] | join("; "))]]}
    | .meta.csv_columns.baseline = ["Account", "Region", "Resource", "Resource type", "Cluster", "Engine", "Version", "Parameter",
                                    "Expected rule", "Actual", "Source group", "Status", "Severity", "Overridden on (instance=value)"]
  end
