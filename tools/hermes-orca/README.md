# Hermes Orca launch guard

The isolated Hermes HOME does not contain the desktop Orca runtime metadata. This launcher supplies `ORCA_USER_DATA_PATH` for the real existing app profile without changing HOME, authentication, services, or the vendor CLI.

Hermes `orca open` and `orca serve` return `orca_automatic_start_blocked`. Status, skills, browser and computer commands still reach the installed CLI. When Orca is closed, report that native UI access is unavailable and prefer existing APIs/browser routes. A user may open Orca normally; the guard is confined to the isolated Hermes environment.

Run `python3 -m unittest discover -s tools/hermes-orca -p 'test_*.py'`. Plan installation with `python3 tools/hermes-orca/install.py --root /absolute/candidate`; add `--apply` after reviewing the plan. It installs a private launcher and policy in candidate/bin and managed blocks in the isolated `.bash_profile` and `.zprofile`. Login shells bind only the `orca` command to the guard, preserving PATH and every other command's resolution. Each new Hermes shell sees the change, without a gateway restart. The installer preserves existing profile content and refuses unrelated launchers or symlinked profiles.

Backups and a path/hash receipt are kept under candidate/control/orca-guard/backups. For rollback, verify each installed hash against its receipt, restore the recorded original files, and remove only receipt-listed newly created files. Never copy or print credentials or change the real user's shell profiles.

Other Hermes screen-control backends are separate choices: its browser tools use a browser backend, and `computer_use` supports cua-driver. Their configuration and permissions must be verified before enabling them. This fix does not install a new driver or claim those backends are ready.
