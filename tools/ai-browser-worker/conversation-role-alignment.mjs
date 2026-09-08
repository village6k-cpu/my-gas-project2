// Message width cannot identify its sender. Use matching bubble edges from
// independently classified messages, and retain unknown when anchors conflict.
// Self-contained because this function also runs inside the capture expression.
export function resolveAlignedMessageRoles(rows) {
  const finite = row => Number.isFinite(row.left) && Number.isFinite(row.right) && row.right > row.left;
  const anchors = rows.filter(row => finite(row) && ['customer', 'staff'].includes(row.role));
  return rows.map(row => {
    if (row.role !== 'unknown' || !finite(row)) return {...row};
    const customer = anchors.some(anchor => anchor.role === 'customer' && Math.abs(anchor.left-row.left) <= 2);
    const staff = anchors.some(anchor => anchor.role === 'staff' && Math.abs(anchor.right-row.right) <= 2);
    return {...row,role:customer === staff ? 'unknown' : customer ? 'customer' : 'staff'};
  });
}
