# Hermes SQLite reader lifecycle maintenance

The Kakao worker exhausted its process file descriptors while keeping retired
thread readers open. `SessionDB._read_conns` retained a strong reference to every
short-lived thread's connection until database shutdown. Those readers also used
SQLite's default thread ownership, so shutdown from the gateway thread could not
close them reliably.

The patch tracks each reader's owning thread, releases only terminated owners,
and allows that controlled cross-thread cleanup. Active readers remain private
to their owning threads. It changes no database schema or reservation data.

Apply only to a verified matching Hermes source tree after backing up the source:

```sh
patch --dry-run -p1 -i /absolute/path/sessiondb-reader-lifecycle.patch
patch -p1 -i /absolute/path/sessiondb-reader-lifecycle.patch
```

Run the real SQLite regression against that source using its Python runtime:

```sh
HERMES_RUNTIME_SOURCE=/absolute/path/to/hermes-code python /absolute/path/test_sessiondb_reader_lifecycle.py
```

The tests create a disposable HERMES_HOME, open no production DB, verify bounded
connections across 40 terminated threads, preserve a concurrently active reader,
and verify the tracked connections are actually released on close. Keep runtime
integrity manifests and activation gates intact when deploying the reviewed patch.
