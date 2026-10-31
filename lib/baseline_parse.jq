# baseline_parse.jq - reads a parameters.baseline file as plain text (never sourced / evaluated).
# Usage: jq -Rs -f baseline_parse.jq FILE  ->  {rules: [{line, family, param, rule, value, sev}], errors: ["line N: ..."]}
def FAMILIES: ["postgres", "aurora-postgresql", "rds-postgres", "mysql", "aurora-mysql", "sqlserver", "oracle"];
def RULES: ["=", "!=", "in", "contains", "!contains", ">", ">=", "<", "<=", "between", "set"];
def trim: sub("^[ \t]+"; "") | sub("[ \t]+$"; "");
def isnum: test("^-?[0-9]+(\\.[0-9]+)?$");
def check($n):
    (split("|") | map(trim)) as $f
    | if ($f | length) != 5 then {err: "line \($n): expected 5 fields (engine-family | parameter | rule | value | severity), found \($f | length)"}
      else ($f[0] | ascii_downcase) as $fam | $f[1] as $p | $f[2] | ascii_downcase as $r | $f[3] as $v | ($f[4] | ascii_downcase) as $s
      | if (FAMILIES | index([$fam])) == null then {err: "line \($n): unknown engine family '\($f[0])' (\(FAMILIES | join(", ")))"}
        elif ($p | test("^[A-Za-z0-9_.()][A-Za-z0-9_.() -]{0,127}$") | not) then {err: "line \($n): bad parameter name '\($p)'"}
        elif (RULES | index([$r])) == null then {err: "line \($n): unknown rule '\($f[2])' (\(RULES | join(" ")))"}
        elif (["high", "medium", "low"] | index([$s])) == null then {err: "line \($n): unknown severity '\($f[4])' (high, medium, low)"}
        elif $r == "set" and $v != "" then {err: "line \($n): rule 'set' takes no value"}
        elif $r != "set" and $v == "" then {err: "line \($n): rule '\($r)' needs a value"}
        elif ($r | test("^[<>]=?$")) and ($v | isnum | not) then {err: "line \($n): rule '\($r)' needs a number, got '\($v)'"}
        elif $r == "between" and (($v | test("^-?[0-9]+(\\.[0-9]+)?-(-?[0-9]+(\\.[0-9]+)?)$") | not)
                                 or ($v | capture("^(?<a>-?[0-9.]+)-(?<b>-?[0-9.]+)$") | (.a | tonumber) > (.b | tonumber))) then {err: "line \($n): rule 'between' needs MIN-MAX (MIN <= MAX), got '\($v)'"}
        elif ($v | test("[\u0000-\u001f]")) then {err: "line \($n): control character in value"}
        else {rule: {line: $n, family: $fam, param: $p, rule: $r, value: $v, sev: $s}} end end;

[split("\n") | to_entries[] | {n: (.key + 1), l: (.value | rtrimstr("\r") | trim)} | select(.l != "" and (.l | startswith("#") | not)) | .l as $l | .n as $n | $l | check($n)] as $x
| [$x[] | .rule // empty] as $rules
| {rules: $rules,
   errors: ([$x[] | .err // empty]
     + [$rules | group_by([.family, .param, .rule, .value])[] | select(length > 1) | "line \(.[1].line): duplicate of line \(.[0].line)"])}
