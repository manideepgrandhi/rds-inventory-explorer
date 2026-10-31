# insights.jq - adds the Insights tab data to the model built by explorer.jq. No AWS calls: it reads only the
# describe-* output already kept in each resource's .raw.
# Usage: jq --argjson skip '["default_port", ...]' -f insights.jq model.json
# Adds: .resources[].ins (facets for the fleet summary) and .insights {checks, findings, skipped, omitted}.
# Aurora / Multi-AZ DB clusters: cluster-level settings (encryption, deletion protection, copy tags, backup retention,
# IAM auth, log exports, port, master user) are checked once on the cluster, never on its members. Instance-level
# settings (public access, class, CA, Performance Insights, Enhanced Monitoring, auto minor upgrade) are checked per
# instance, except where a Multi-AZ DB cluster holds them at cluster level.

def CHECKS: [
  {id: "public_access",          sev: "High",   label: "Publicly accessible",            fix: "Turn off public access; reach it through private subnets / VPN"},
  {id: "storage_not_encrypted",  sev: "High",   label: "Storage not encrypted",          fix: "Snapshot, copy the snapshot with a KMS key, restore from the copy"},
  {id: "deletion_protection_off",sev: "High",   label: "Deletion protection off",        fix: "Enable deletion protection"},
  {id: "copy_tags_off",          sev: "Medium", label: "Copy tags to snapshots off",     fix: "Enable copy tags to snapshots"},
  {id: "single_az",              sev: "Medium", label: "Single-AZ",                      fix: "Instance: enable Multi-AZ. Aurora: add a reader in another AZ"},
  {id: "backup_retention_low",   sev: "Medium", label: "Backup retention < 7 days",      fix: "Set backup retention to 7 days or more"},
  {id: "iam_auth_off",           sev: "Medium", label: "IAM DB authentication off",      fix: "Enable IAM database authentication"},
  {id: "ca_expiring",            sev: "Medium", label: "CA certificate expires < 90 days", fix: "Rotate to rds-ca-rsa2048-g1 or newer"},
  {id: "auto_minor_off",         sev: "Low",    label: "Auto minor version upgrade off", fix: "Enable auto minor version upgrade or patch on a schedule"},
  {id: "pi_off",                 sev: "Low",    label: "Performance Insights off",       fix: "Enable Performance Insights (7 days free)"},
  {id: "em_off",                 sev: "Low",    label: "Enhanced Monitoring off",        fix: "Set a monitoring interval (e.g. 60 s)"},
  {id: "no_log_exports",         sev: "Low",    label: "No CloudWatch log exports",      fix: "Export the engine logs to CloudWatch Logs"},
  {id: "default_port",           sev: "Low",    label: "Default port",                   fix: "Use a non-default port"},
  {id: "default_master_user",    sev: "Low",    label: "Default master username",        fix: "Use a non-default master user name"},
  {id: "old_generation",         sev: "Low",    label: "Previous-generation class",      fix: "Move to a current class (e.g. Graviton m7g / r7g)"},
  {id: "gp2_storage",            sev: "Low",    label: "gp2 storage",                    fix: "Move to gp3 (same or better baseline, lower cost)"},
  {id: "stopped",                sev: "Low",    label: "Stopped",                        fix: "Start or delete it; AWS starts it again after 7 days"},
  {id: "default_param_group",    sev: "Medium", label: "Default parameter group in use", fix: "Attach a custom (cluster / instance) parameter group; default.* groups cannot be changed"},
  # parameter checks: run only on data from --with-parameters (effective values, see parameters.jq)
  {id: "ssl_not_forced",         sev: "High",   label: "SSL / TLS not forced",           fix: "Set rds.force_ssl = 1 (PostgreSQL, SQL Server) or require_secure_transport = ON (MySQL)", params: true},
  {id: "tls_old_enabled",        sev: "High",   label: "TLS 1.0 / 1.1 enabled",          fix: "Set rds.tls10 and rds.tls11 = disabled", params: true},
  {id: "conn_logging_off",       sev: "Medium", label: "Connection logging off",         fix: "Set log_connections = 1 (and log_disconnections = 1)", params: true},
  {id: "md5_password",           sev: "Medium", label: "md5 password encryption",        fix: "Set password_encryption = scram-sha-256 and reset the passwords", params: true},
  {id: "param_pending_reboot",   sev: "Low",    label: "Parameter change pending reboot", fix: "Reboot in the next maintenance window to apply the parameter group", params: true}];

def PORTS: {"postgres": 5432, "aurora-postgresql": 5432, "mysql": 3306, "mariadb": 3306, "aurora-mysql": 3306, "aurora": 3306,
            "docdb": 27017, "neptune": 8182};
def def_port: if startswith("sqlserver") then 1433 elif startswith("oracle") then 1521 elif startswith("db2") then 50000 else PORTS[.] end;
def DEFAULT_USERS: ["postgres", "admin", "sa", "root", "master"];
# vCPUs from the class size (approximate: standard x86 / Graviton classes only; null when unknown)
def vcpu: if type != "string" then null else split(".") as $p
    | if ($p | length) != 3 or $p[0] != "db" then null
      else ($p[1]) as $fam | ($p[2]) as $sz
        | if ($fam == "t2" and ($sz == "micro" or $sz == "small")) then 1
          elif ($sz == "micro" or $sz == "small" or $sz == "medium" or $sz == "large") then 2
          elif $sz == "xlarge" then 4
          elif ($sz | test("^[0-9]+xlarge$")) then ($sz | rtrimstr("xlarge") | tonumber) * 4
          else null end end end;
def family: if type != "string" then null else (split(".") | if length >= 3 then .[1] else null end) end;
def OLD_GEN: "^(m1|m2|m3|m4|r3|r4|t1|t2|cr1)$";   # previous-generation families
def yesno: if . == true then "on" elif . == false then "off" else "not set" end;

($skip // []) as $SKIP
| (CHECKS | map({key: .id, value: .}) | from_entries) as $C
| ([.resources[] | select(.type == "cluster") | {key: .id, value: .raw}] | from_entries) as $CL
| .meta as $meta
| def f($id; $r; $val): if ($SKIP | index([$id])) then empty else
      $C[$id] as $c | {check: $id, sev: $c.sev, label: $c.label, fix: $c.fix, value: $val,
                       res_id: $r.id, unit_id: (if $r.type == "member" then ($r.d.cluster.id // $r.id) else $r.id end), res_name: $r.name, res_type: $r.type, account: $r.account, region: $r.region, engine: $r.engine} end;
  # checks of the settings that live on a cluster or a standalone instance
  def deploy_checks($r): $r.raw as $x | ($r.engine) as $e | ($r.type == "cluster") as $isc
    | (if $x.StorageEncrypted != true then f("storage_not_encrypted"; $r; "StorageEncrypted = \($x.StorageEncrypted | yesno)") else empty end),
      (if $x.DeletionProtection != true then f("deletion_protection_off"; $r; "DeletionProtection = \($x.DeletionProtection | yesno)") else empty end),
      (if $x.CopyTagsToSnapshot != true then f("copy_tags_off"; $r; "CopyTagsToSnapshot = \($x.CopyTagsToSnapshot | yesno)") else empty end),
      (if ($x.ReadReplicaSourceDBInstanceIdentifier == null) and (($x.BackupRetentionPeriod // 0) < 7)
       then f("backup_retention_low"; $r; "\($x.BackupRetentionPeriod // 0) day(s)") else empty end),
      (if ($e | test("^(sqlserver|oracle|docdb|db2)") | not) and $x.IAMDatabaseAuthenticationEnabled != true
       then f("iam_auth_off"; $r; "IAMDatabaseAuthenticationEnabled = \($x.IAMDatabaseAuthenticationEnabled | yesno)") else empty end),
      (if (($x.EnabledCloudwatchLogsExports // []) | length) == 0 then f("no_log_exports"; $r; "none") else empty end),
      ((if $isc then $x.Port else $x.Endpoint.Port end) as $p | ($e | def_port) as $dp
       | if $p != null and $dp != null and $p == $dp then f("default_port"; $r; "\($p)") else empty end),
      (($x.MasterUsername // "") as $u | if (DEFAULT_USERS | index([$u | ascii_downcase])) then f("default_master_user"; $r; $u) else empty end),
      (if $x.StorageType == "gp2" then f("gp2_storage"; $r; "gp2") else empty end),
      (if $isc then
         (if ($x.DBClusterInstanceClass == null) and (($x.DBClusterMembers // []) | length) < 2
          then f("single_az"; $r; "\(($x.DBClusterMembers // []) | length) instance(s), no reader") else empty end),
         (if ($x.Status // "") == "stopped" then f("stopped"; $r; "stopped") else empty end),
         (if ($x | has("AutoMinorVersionUpgrade")) and $x.AutoMinorVersionUpgrade != true then f("auto_minor_off"; $r; "off") else empty end),
         (if ($x | has("PerformanceInsightsEnabled")) and $x.PerformanceInsightsEnabled != true then f("pi_off"; $r; "off") else empty end)
       else
         (if $x.MultiAZ != true then f("single_az"; $r; "MultiAZ = \($x.MultiAZ | yesno)") else empty end)
       end);
  # checks of the settings every instance (standalone or cluster member) has
  def node_checks($r): $r.raw as $x | (if $r.type == "member" then ($CL[$r.d.cluster.id] // {}) else {} end) as $pc
    | (if $x.PubliclyAccessible == true then f("public_access"; $r; "PubliclyAccessible = on") else empty end),
      (if ($pc | has("AutoMinorVersionUpgrade")) | not then
         (if $x.AutoMinorVersionUpgrade != true then f("auto_minor_off"; $r; "off") else empty end) else empty end),
      (if ($pc | has("PerformanceInsightsEnabled")) | not then
         (if $x.PerformanceInsightsEnabled != true then f("pi_off"; $r; "off") else empty end) else empty end),
      (if ($x.MonitoringInterval // 0) == 0 then f("em_off"; $r; "MonitoringInterval = 0") else empty end),
      (($r.d.ca // null) as $ca | if $ca != null and $ca.valid_till != null and $ca.valid_till.days < 90
       then f("ca_expiring"; $r; "\($ca.id): \($ca.valid_till.utc) / \($ca.valid_till.local) (\($ca.valid_till.days) days)") else empty end),
      (($r.class | family) as $fm | if $fm != null and ($fm | test(OLD_GEN)) then f("old_generation"; $r; $r.class) else empty end),
      (if $r.type == "instance" and ($x.DBInstanceStatus // "") == "stopped" then f("stopped"; $r; "stopped") else empty end);

  [.resources[] | . as $r
   | if .type == "cluster" then deploy_checks($r)
     elif .type == "instance" then deploy_checks($r), node_checks($r)
     elif .type == "member" then node_checks($r)
     else empty end,
   # default.* parameter group (known from describe-db-*; no --with-parameters needed)
   (if .type == "cluster" then (.d.param_group // "") as $g | if $g | startswith("default.") then f("default_param_group"; .; "cluster group \($g)") else empty end
    elif .type == "instance" or .type == "member" then ([(.d.param_groups // [])[].name | select(startswith("default."))][0]) as $g
      | if $g then f("default_param_group"; .; "instance group \($g)") else empty end
    else empty end)] as $F0
| ([.resources[] | {key: .id, value: .}] | from_entries) as $RES
| (.parameters.rows // []) as $PROWS
# parameter checks: on the cluster and standalone instances; on a member only for a value its instance group sets
| [$PROWS[] | . as $p | $RES[.res_id] as $r | select($r != null)
   | (.values | to_entries[] | select(.value.flag != null and ($p.type != "member" or .value.from == "instance")) | .key as $n | .value as $v
      | ({"rds.force_ssl": "ssl_not_forced", "require_secure_transport": "ssl_not_forced", "rds.tls10": "tls_old_enabled", "rds.tls11": "tls_old_enabled",
          "log_connections": "conn_logging_off", "password_encryption": "md5_password"}[$n]) as $id
      | select($id != null) | f($id; $r; "\($n) = \($v.v // "(empty)") (\(if $v.from == "default" then "engine default" else "\($v.from) group, " + ($v.src // "") end))")),
     ([$p.apply_status, $p.cluster_apply_status] | map(select(. == "pending-reboot")) | if length > 0 then
        f("param_pending_reboot"; $r; "ParameterApplyStatus = pending-reboot (\(if $p.apply_status == "pending-reboot" then "instance group" else "cluster group" end))") else empty end)] as $FP
| ($F0 + ($FP | group_by(.check, .res_id) | map(.[0] + {value: (map(.value) | unique | join("; "))}))) as $F
| ({High: 0, Medium: 1, Low: 2}) as $SR
| ($F | sort_by($SR[.sev], .check, .account, .region, .res_name)
      | map(. + {csv: ([.sev, .account, .region, .res_name, .res_type, .engine, .label, .value, .fix] | map(if . == null then "" else tostring end))})) as $FS
| .resources |= map(. as $r | .raw as $x
    | if .type == "global" then . + {ins: null}
      else . + {ins: {
        unit: (.type == "cluster" or .type == "instance"),
        node: (.type == "instance" or .type == "member"),
        engine: .engine,
        version: "\(.engine) \(.version)",
        class: (if .type == "cluster" then null else .class end),
        family: (if .type == "cluster" then null else (.class | family) end),
        vcpu: (if .type == "cluster" then null else (.class | vcpu) end),
        az: (if .type == "cluster" then (if ($x.DBClusterInstanceClass != null) or (($x.DBClusterMembers // []) | length) > 1 then "Multi-AZ" else "Single-AZ" end)
             elif .type == "instance" then (if $x.MultiAZ == true then "Multi-AZ" else "Single-AZ" end) else null end),
        storage: (if .type == "member" then null else ($x.StorageType // (if (.engine | startswith("aurora")) then "aurora" else "n/a" end)) end),
        gb: (if .type == "instance" then $x.AllocatedStorage elif .type == "cluster" and ($x.DBClusterInstanceClass != null) then $x.AllocatedStorage else null end)}} end)
| .meta.csv_columns.insights_findings = ["Severity", "Account", "Region", "Resource", "Resource type", "Engine", "Check", "Current value", "Fix hint"]
| (.parameters.collected // false) as $PC
| .insights = {checks: [CHECKS[] | .id as $i | . + {skipped: (($SKIP | index([$i])) != null), not_run: ((.params // false) and ($PC | not))}], findings: $FS, skipped: $SKIP,
               omitted: ["Engine version in Extended Support: describe-db-* only shows the lifecycle enrollment setting, not whether the version is past standard support, so it is not checked."]}
