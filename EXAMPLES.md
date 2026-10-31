# Examples

```bash
# Current CloudShell login, every enabled region (empty regions skipped by a quick probe)
./rds_inventory_explorer.sh -A -o ./out

# Two profiles, HTML + the three CSVs, and save the data for merging
./rds_inventory_explorer.sh -P prod,dev -A -F html,csv --save-data -o ./out

# CSVs only (inventory, pending maintenance, insights findings)
./rds_inventory_explorer.sh -A -F csv -o ./out

# Skip Insights checks you do not care about
./rds_inventory_explorer.sh -A --skip-checks default_port,gp2_storage,stopped

# Parameters tab: effective values of the curated parameters, drift, parameter Insights checks (+ _parameters.csv)
./rds_inventory_explorer.sh -P prod -A --with-parameters -F html,csv

# Check every resource against your parameter baseline (copy the bundled one outside the release folder first)
cp lib/parameters.baseline.example ~/parameters.baseline
./rds_inventory_explorer.sh -P prod -A --with-parameters --baseline ~/parameters.baseline -F html,csv
#   report.html#tab=parameters&pv=drift shows the off-baseline clusters and instances first; --baseline none turns it off

# Merge several accounts and check them all against one baseline
./rds_inventory_explorer.sh --merge ~/Downloads/rds --baseline ~/parameters.baseline -o ~/Downloads/rds/merged

# Open a report on the parameter group view or on one group's drift
#   report.html#tab=parameters&pv=group     report.html#tab=parameters&pv=drift

# See the exact AWS calls first, without calling anything
./rds_inventory_explorer.sh -P prod -A --dry-run

# Settings file (the CLI overrides it)
./rds_inventory_explorer.sh --config rds_inventory_explorer.conf.example

# Windows Git Bash, offline: merge the data files downloaded from each account's CloudShell
./rds_inventory_explorer.sh --merge ~/Downloads/rds -F html,csv -o ~/Downloads/rds/merged

# Open a report straight on the Insights tab
#   rds_inventory_explorer_111111111111_20261017_120000.html#tab=insights
```
