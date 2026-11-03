# Hermes native and browser tools

This migration replaces the root Orca discovery skill with Hermes's existing canonical cua-driver skill, archives the Orca-only CLI/orchestration skills, repairs executable resolution, and connects browser tools to the already-authenticated dedicated Chrome at loopback port 19223. The worker gains browser and computer toolsets while retaining every existing tool and approval setting.

Borrowed Chrome sessions open a new task-owned tab before navigation; cleanup disconnects the tool client rather than closing the shared browser. Existing customer/watch tabs must retain their IDs and URLs during verification. Native tests use an isolated Cua socket and a disposable document on display 16MR70. The old Cua and Orca installations are not removed.

Run switch.py with the isolated installation root and an officially signed driver binary inside its tools directory. The default is a dry run. Review the paths before adding --apply. It refuses to apply while either gateway reports active agents. Backups include exact original files and installed hashes under control/ui-tools-backups. The service manifest hashes are updated for the changed tool settings; original activation gates remain unchanged. No credentials, customer records, model, prices, queues, or financial settings are changed. Gateways must be gracefully restarted only after active work drains so their new executable environment is loaded.

Roll back by checking installed hashes against the backup receipt, restoring the original files and archived skill directories, removing only receipt-listed new files, and restarting the idle gateways. Never restore queues or resend customer messages as part of this tool migration.
