# Permission Justifications

Required by the Chrome Web Store review process.

## `storage`
Used to persist the user's selected avatar ID, walk speed, position preference,
site allowlist/blocklist, and narration settings across browser sessions via
`chrome.storage.sync` (synced across user's devices) and the session auth token
via `chrome.storage.local`.

## `activeTab`
Used to read the current tab's URL hostname so the popup can display "Enable on
this site" with the correct domain name. Also used to send messages to the active
tab's content script when the user toggles the avatar.

## `scripting`
Used to inject `content.js` into the user's active tab when they explicitly enable
the walking avatar via the popup toggle. The script is never injected automatically
on all pages — injection only occurs on user action.

## `host_permissions: <all_urls>`
Required because the user can enable the avatar on any website they choose to visit.
The content script is injected only into tabs where the user has explicitly enabled
the extension. The extension does not automatically run on every page.
