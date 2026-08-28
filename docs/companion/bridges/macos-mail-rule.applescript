(*
	Apple Mail -> three.ws Companion
	--------------------------------
	A Mail rule that hands every message it matches to your companion, which
	decides whether it is worth interrupting you for. Everything runs on your
	Mac; the only thing that leaves it is the sender, the subject, and the
	preview you allow below.

	Setup:
	  1. Save this file as ~/Library/Application Scripts/com.apple.mail/companion.scpt
	     (open it in Script Editor, then File -> Save, format "Script").
	  2. Put your bridge token from https://three.ws/companion into the
	     `token` line below, or leave it empty to read it from
	     ~/.config/three-ws/companion.json, which `companion login` writes.
	  3. Mail -> Settings -> Rules -> Add Rule.
	     Condition: whatever you actually want to hear about (a VIP sender, a
	     mailbox, "from anyone" if you trust the triage to filter for you).
	     Action: Run AppleScript -> companion.scpt.

	The rule fires on incoming mail only, so nothing is replayed when you rebuild
	your mailboxes.
*)

property endpoint : "https://three.ws/api/companion/ingest"
property token : "" -- paste cmp_… here, or leave empty to read the CLI's config
property previewCharacters : 400 -- set to 0 to send subject and sender only

on companionToken()
	if token is not "" then return token
	try
		set configPath to (POSIX path of (path to home folder)) & ".config/three-ws/companion.json"
		set raw to do shell script "cat " & quoted form of configPath
		-- The config is small and flat; pull the token without a JSON library.
		set AppleScript's text item delimiters to "\"token\""
		set tail to text item 2 of raw
		set AppleScript's text item delimiters to "\""
		set found to text item 2 of tail
		set AppleScript's text item delimiters to ""
		return found
	on error
		return ""
	end try
end companionToken

-- JSON is quoted for a shell command, so both layers of escaping matter.
on jsonEscape(theText)
	set out to ""
	repeat with i from 1 to count of characters of theText
		set c to character i of theText
		if c is "\"" then
			set out to out & "\\\""
		else if c is "\\" then
			set out to out & "\\\\"
		else if c is return or c is linefeed then
			set out to out & "\\n"
		else if c is tab then
			set out to out & "\\t"
		else
			set out to out & c
		end if
	end repeat
	return out
end jsonEscape

on truncate(theText, theLimit)
	if theLimit is 0 then return ""
	if (count of characters of theText) > theLimit then
		return text 1 thru theLimit of theText
	end if
	return theText
end truncate

using terms from application "Mail"
	on perform mail action with messages theMessages for rule theRule
		set theToken to companionToken()
		if theToken is "" then return

		tell application "Mail"
			repeat with eachMessage in theMessages
				try
					set theSubject to subject of eachMessage
					set theSenderName to extract name from sender of eachMessage
					set theSenderAddress to extract address from sender of eachMessage
					set theId to message id of eachMessage
					set theBody to ""
					if previewCharacters > 0 then
						set theBody to my truncate(content of eachMessage, previewCharacters)
					end if

					set payload to "{" & ¬
						"\"title\":\"" & my jsonEscape(theSubject) & "\"," & ¬
						"\"body\":\"" & my jsonEscape(theBody) & "\"," & ¬
						"\"sender\":\"" & my jsonEscape(theSenderName) & "\"," & ¬
						"\"sender_id\":\"" & my jsonEscape(theSenderAddress) & "\"," & ¬
						"\"app\":\"Mail\"," & ¬
						"\"id\":\"apple-mail:" & my jsonEscape(theId) & "\"" & ¬
						"}"

					do shell script "/usr/bin/curl -sS -m 10 -X POST " & quoted form of endpoint & ¬
						" -H " & quoted form of ("Authorization: Bearer " & theToken) & ¬
						" -H 'Content-Type: application/json'" & ¬
						" --data-binary " & quoted form of payload & " >/dev/null"
				on error errorMessage
					-- One bad message must never stop the rule from handling the rest.
					log "companion bridge: " & errorMessage
				end try
			end repeat
		end tell
	end perform mail action with messages
end using terms from
