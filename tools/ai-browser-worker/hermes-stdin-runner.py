"""Launch Hermes with a query supplied over stdin, not the Windows command line."""

import json
import sys


def main() -> None:
    payload = json.load(sys.stdin)
    argv = payload.get("argv")
    query = payload.get("query")
    if not isinstance(argv, list) or not all(isinstance(value, str) for value in argv):
        raise ValueError("argv must be a list of strings")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if "-q" in argv or "--query" in argv:
        raise ValueError("query flags must not be supplied in argv")

    sys.argv = ["hermes", *argv, "-q", query]
    from hermes_cli.main import main as hermes_main

    hermes_main()


if __name__ == "__main__":
    main()
