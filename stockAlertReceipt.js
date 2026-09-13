// Slack converts Unicode emoji to aliases in conversations.history. Normalize
// only the icons this notice emits; metadata identity and all wording still match.
function stockAlertSlackText_(text) {
  return String(text || '').replace(/🚨/g,':rotating_light:').replace(/⚠\uFE0F?/g,':warning:')
    .replace(/🗓\uFE0F?/g,':spiral_calendar_pad:').replace(/🔴/g,':red_circle:')
    .replace(/❓/g,':question:').replace(/👉/g,':point_right:');
}
if(typeof module!=='undefined')module.exports={stockAlertSlackText_};
