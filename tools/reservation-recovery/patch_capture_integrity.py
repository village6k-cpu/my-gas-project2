"""A Kakao deletion placeholder is UI metadata, never a rental message."""
def patch(source):
 if 'deleted_message_placeholder' in source:return source
 anchor="  const needle = preview.replace(/(?:…|\\.{3})+$/u, '');"
 assert source.count(anchor)==1
 return source.replace(anchor,"""  // The list can show a deletion placeholder that does not exist in message
  // bubbles. Exact-room/title/message evidence remains mandatory upstream.
  if (/^메시지가삭제되었습니다[.!]?$/u.test(preview)) {
    return { ok: true, reason: 'deleted_message_placeholder' };
  }
"""+anchor)
