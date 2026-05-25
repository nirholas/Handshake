# Chrome Web Store Release Checklist

Complete every item before each submission.

## Pre-build
- [ ] Version bumped in `package.json` (semver)
- [ ] `CHANGELOG.md` entry written for this version
- [ ] All console.log / debug statements removed from production build
- [ ] Privacy policy at `https://three.ws/extension/privacy` is live and accurate
- [ ] Terms of service at `https://three.ws/extension/terms` is live and accurate

## Build
```bash
npm run build:extension:prod
```
- [ ] Build succeeds with zero errors
- [ ] `dist/extension-<version>.zip` created
- [ ] Load `dist/extension/` via chrome://extensions → Load unpacked, confirm no manifest errors

## Functional QA
- [ ] Popup opens and renders correctly
- [ ] Sign-in flow works (opens three.ws/login?redirect=extension)
- [ ] Avatar list loads from real API after sign-in
- [ ] Selecting avatar updates the walking iframe on the current tab
- [ ] Enable toggle injects avatar on current tab
- [ ] Disable toggle removes avatar cleanly
- [ ] Avatar persists through SPA navigation (test on Twitter/X)
- [ ] Drag handle repositions the avatar
- [ ] Close button removes avatar from page
- [ ] Settings page saves and syncs settings
- [ ] Allowlist/blocklist filtering works
- [ ] Narration reads sections aloud (if narration enabled)
- [ ] Speed slider live-updates walk speed

## Store Listing Assets
Located in `extensions/walk-avatar/store-assets/`:
- [ ] 128×128 icon (icon-128.png)
- [ ] 440×280 small promotional tile
- [ ] 1280×800 marquee promotional image
- [ ] 5× screenshots (1280×800) showing real usage on real websites
  - Screenshot 1: Avatar walking on a news article site
  - Screenshot 2: Popup with avatar selection grid
  - Screenshot 3: Settings page
  - Screenshot 4: Avatar narrating sections (speech bubble visible)
  - Screenshot 5: Avatar on a social media page

## Policy Compliance
Review against https://developer.chrome.com/docs/webstore/program-policies/
- [ ] No deceptive behavior — extension only activates on explicit user action
- [ ] No malware — no data sent to third parties without user awareness
- [ ] Privacy disclosure accurate — only three.ws APIs contacted
- [ ] No blocked/dangerous permissions used beyond what is documented in PERMISSIONS.md
- [ ] Extension works offline (avatar still renders; only avatar-swap requires network)

## Submission
1. `npm run build:extension:prod`
2. Upload `dist/extension-<version>.zip` to Chrome Web Store Developer Dashboard
3. Fill in store listing description (under 132 chars for short, full for detailed)
4. Upload all store assets
5. Set privacy policy URL: `https://three.ws/extension/privacy`
6. Submit for review (typically 1-3 business days)
