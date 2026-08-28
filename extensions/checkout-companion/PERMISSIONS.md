# Permissions: three.ws Checkout Companion

Every permission this extension requests, why it needs it, and what it does not
do with it.

## `content_scripts` on `http://*/*` and `https://*/*`

**Why:** a checkout page can be on any domain. There is no list of shopping
sites that would not miss the one you are on.

**What it actually does:** the content script runs on every page and, on nearly
all of them, immediately stops. It performs a local check for whether the page
looks like a checkout (a URL pattern plus page-language score) and returns
without reading anything further, without storing anything, and without making
any network request. Only a page that passes that check is read.

It runs in the top frame only (`all_frames: false`), so it never enters a
payment iframe.

## `host_permissions` for `https://three.ws/*`

**Why:** to send the redacted page extract to the analysis endpoint and to check
whether your account is connected.

**Note:** this is the only host the extension is permitted to contact. It cannot
send data anywhere else, including to the site you are shopping on.

## `storage`

**Why:** to keep your three settings, your optional bridge token, and remembered
prices (one amount per site, one hour, twenty sites maximum).

**What it is not:** it is not a browsing history. Nothing is recorded about
pages that are not checkouts, and no page content is ever stored.

## Permissions this extension deliberately does not request

| Not requested | Why it matters |
| --- | --- |
| `tabs` | It cannot see your open tabs, their URLs, or your browsing history |
| `webRequest` | It cannot observe, intercept, or modify network traffic |
| `cookies` | It cannot read cookies from any site |
| `downloads`, `clipboardRead` | It cannot touch your files or clipboard |
| `scripting` | It cannot inject code into pages on demand |
| Host permissions for any site other than three.ws | It cannot exfiltrate data anywhere else |

See [PRIVACY.md](PRIVACY.md) for what is read, sent, and kept.
