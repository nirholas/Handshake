/**
 * Gmail -> three.ws Companion
 * ---------------------------
 * Forwards new mail matching a search into your companion, which triages it and
 * decides whether it is worth interrupting you for. Runs inside YOUR Google
 * account, so three.ws never sees your mailbox or your credentials.
 *
 * Setup, about two minutes:
 *   1. script.google.com  ->  New project  ->  paste this file.
 *   2. Project Settings -> Script Properties, add:
 *        COMPANION_TOKEN   your bridge token from https://three.ws/companion
 *      (Optional: COMPANION_URL to point at a different server, and
 *       COMPANION_QUERY to change what is watched.)
 *   3. Run `forwardToCompanion` once and approve the permissions it asks for.
 *   4. Triggers (the clock icon) -> Add Trigger -> forwardToCompanion,
 *      Time-driven, Minutes timer, every 5 minutes.
 *
 * What leaves your account: the sender, the subject, and the first 800
 * characters of the body. Set REDACT_BODY to true below and only the sender and
 * subject are sent.
 */

var DEFAULT_URL = 'https://three.ws/api/companion/ingest';
var DEFAULT_QUERY = 'is:unread -category:promotions -category:social -category:updates newer_than:1d';
var MAX_MESSAGES = 25;
var REDACT_BODY = false;

function forwardToCompanion() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('COMPANION_TOKEN');
  if (!token) throw new Error('Set COMPANION_TOKEN in Project Settings -> Script Properties.');

  var endpoint = props.getProperty('COMPANION_URL') || DEFAULT_URL;
  var query = props.getProperty('COMPANION_QUERY') || DEFAULT_QUERY;
  // Everything already seen is remembered as a timestamp, so a message is
  // forwarded exactly once even though the search keeps matching it.
  var seenUntil = Number(props.getProperty('COMPANION_SEEN_UNTIL') || 0);
  var newest = seenUntil;

  var threads = GmailApp.search(query, 0, MAX_MESSAGES);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var message = messages[m];
      var stamp = message.getDate().getTime();
      if (stamp <= seenUntil) continue;
      newest = Math.max(newest, stamp);

      var from = message.getFrom();                       // "Sarah K <sarah@example.com>"
      var address = (from.match(/<([^>]+)>/) || [null, from])[1];
      var name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || address;

      var payload = {
        title: message.getSubject() || '(no subject)',
        sender: name,
        sender_id: address,
        app: 'Gmail',
        id: 'gmail:' + message.getId(),
        occurred_at: message.getDate().toISOString(),
        url: 'https://mail.google.com/mail/u/0/#inbox/' + threads[t].getId()
      };
      if (!REDACT_BODY) payload.body = String(message.getPlainBody() || '').slice(0, 800);

      var response = UrlFetchApp.fetch(endpoint, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() >= 400) {
        // Logged rather than thrown: one rejected message must not stop the
        // rest of the batch, and the trigger runs again in five minutes.
        console.warn('companion rejected a message: ' + response.getResponseCode() + ' ' + response.getContentText());
      }
    }
  }

  props.setProperty('COMPANION_SEEN_UNTIL', String(newest));
}

/** Run once by hand to check the token and the endpoint. */
function testCompanion() {
  var props = PropertiesService.getScriptProperties();
  var response = UrlFetchApp.fetch(props.getProperty('COMPANION_URL') || DEFAULT_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props.getProperty('COMPANION_TOKEN') },
    payload: JSON.stringify({
      title: 'Gmail bridge is connected',
      body: 'This came from your own Apps Script project.',
      sender: 'Gmail',
      app: 'Gmail',
      priority: 'high'
    }),
    muteHttpExceptions: true
  });
  console.log(response.getResponseCode() + ' ' + response.getContentText());
}
