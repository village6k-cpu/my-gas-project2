"""A bind probe must use the same TIME_WAIT reuse behavior as the server."""
def patch(source):
 if 'probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)' in source:return source
 anchor="            with socket.socket() as probe:probe.bind(('127.0.0.1',port))"
 assert source.count(anchor)==1
 return source.replace(anchor,"""            with socket.socket() as probe:
                # Match Node's listener behavior after a clean TCP shutdown.
                # A prior connection's TIME_WAIT is not a running incumbent.
                probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                probe.bind(('127.0.0.1',port))""")
