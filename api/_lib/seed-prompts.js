// @ts-check
// Curated prompt pool for the forge auto-seed cron and the bulk batch runner
// (gcp-credits work order 05 task 5, still open: not in the tree yet). Every
// prompt targets the FLUX text→image →
// TRELLIS image→3D pipeline. Realistic human subjects with strong silhouettes
// and clear costume detail produce the best meshes at draft quality — avoid thin
// objects, transparent materials, and busy backgrounds.
//
// Two categories: 'avatar' (humanoid characters — realistic, fantasy, sci-fi,
// stylized) and 'accessory' (real-world wearables, carried items, and sculpted
// creature props). The cron alternates so the gallery builds a coherent
// character ecosystem rather than a pile of unrelated objects.
//
// Rig-readiness is the product bar: a catalog avatar exists to be animated, so
// every avatar prompt is rendered through `composeSeedPrompt()` before it hits
// the generator, which appends the full-body / arms-clear / neutral-stance
// framing the auto-rigger needs. Write new avatar prompts as *subject +
// costume*; do not bake framing into the string, or it will be stated twice.
//
// Coin-neutral by rule: no prompt references any crypto project (commit gate in
// CLAUDE.md). Prompts are also brand-neutral — describe the garment, not a
// trademark.

/** @typedef {{ prompt: string, category: 'avatar' | 'accessory', theme: string }} SeedPrompt */

/** @type {SeedPrompt[]} */
export const SEED_PROMPTS = [
	// ── AVATARS — realistic humans ────────────────────────────────────────────

	// Streetwear & urban
	{ prompt: 'a young black man in an oversized white hoodie and baggy jeans, fresh white sneakers, relaxed confident stance, studio lighting', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a hispanic woman in a cropped leather jacket, high-waisted jeans and chunky boots, bold gold hoop earrings, neutral background', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a south asian man in a fitted tracksuit and retro running shoes, gold chain, arms crossed, clean studio background', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a white woman in an oversized graphic tee, biker shorts and platform sneakers, wearing a beanie, street style portrait', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a black woman with natural hair in a brown shearling coat and cargo pants, sculptural jewelry, fashion portrait', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'an east asian man in a monochrome grey tech fleece, slim joggers and clean white sneakers, hands in pockets', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a latina woman in a bright red puffer jacket, low-rise jeans and strappy heels, bold lip, confident pose', category: 'avatar', theme: 'streetwear' },
	{ prompt: 'a middle eastern man in an olive bomber jacket, straight-leg cargos and leather boots, cropped beard, studio portrait', category: 'avatar', theme: 'streetwear' },

	// Athleisure & sports
	{ prompt: 'a muscular black man in a fitted sleeveless gym top and athletic shorts, sports watch, gym portrait lighting', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a fit asian woman in a sports bra and high-waisted leggings, hair in a high ponytail, clean studio background', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a white male runner in a technical running jacket and slim track pants, earbuds, athletic build, daylight portrait', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a black female basketball player in a jersey and shorts, knee sleeve, arms at sides, confident studio pose', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a hispanic male boxer in a satin robe over shorts, hands wrapped, short cropped hair, serious expression', category: 'avatar', theme: 'athletic' },
	{ prompt: 'an asian female martial artist in a white gi with a black belt, hair back, grounded neutral stance', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a south asian male soccer player in a club jersey and shorts, cleats, standing confidently', category: 'avatar', theme: 'athletic' },
	{ prompt: 'a fit white woman in a yoga set, sports bra and seamless leggings, minimal jewelry, soft studio light', category: 'avatar', theme: 'athletic' },

	// Business & professional
	{ prompt: 'a black man in a perfectly fitted charcoal suit, white dress shirt, no tie, polished oxford shoes, executive portrait', category: 'avatar', theme: 'professional' },
	{ prompt: 'an asian woman in a structured blazer and tailored trousers, silk blouse, minimal gold jewelry, office portrait', category: 'avatar', theme: 'professional' },
	{ prompt: 'a white man in a navy business suit and pocket square, silver watch, clean shaven, confident posture', category: 'avatar', theme: 'professional' },
	{ prompt: 'a latina woman in a cream power suit with wide lapels, statement earrings, natural makeup, professional portrait', category: 'avatar', theme: 'professional' },
	{ prompt: 'a south asian man in a slim-fit grey suit and burgundy tie, briefcase in hand, sharp business portrait', category: 'avatar', theme: 'professional' },
	{ prompt: 'a middle eastern woman in a white lab coat over business clothes, stethoscope around neck, professional medical portrait', category: 'avatar', theme: 'professional' },

	// Fashion & editorial
	{ prompt: 'a tall black woman in a sleek black turtleneck and wide-leg trousers, sculptural minimalist look, editorial fashion portrait', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a white man in a vintage denim jacket covered in pins, ripped jeans and chelsea boots, indie fashion portrait', category: 'avatar', theme: 'fashion' },
	{ prompt: 'an east asian woman in a pastel micro-pleated skirt and matching top, platform mary janes, harajuku-inspired look', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a black man in an embroidered silk shirt and white linen trousers, loafers, summer fashion portrait', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a mixed-race woman in a bold geometric print co-ord set, square-toe mules, editorial stance', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a white woman in a long camel trench coat, fitted turtleneck and ankle boots, minimalist chic portrait', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a south asian man in a richly embroidered sherwani, dress shoes, wedding fashion portrait', category: 'avatar', theme: 'fashion' },
	{ prompt: 'a black woman in a red bodycon dress and strappy heels, bold makeup, glamour portrait lighting', category: 'avatar', theme: 'fashion' },

	// Casual & everyday
	{ prompt: 'a young white man in a washed blue denim jacket, plain white tee, slim jeans and canvas shoes, casual portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a black woman in a floral sundress and flat sandals, natural hair down, summer casual portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'an asian man in a quarter-zip pullover, slim chinos and loafers, casual smart portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a hispanic woman in a cozy oversized knit sweater, straight jeans and ankle boots, autumn casual portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a middle eastern man in a crisp linen shirt and tailored shorts, leather sandals, relaxed summer portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a white woman in a classic striped breton top, straight jeans and white sneakers, clean minimalist portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a black man in a rust-colored corduroy jacket, khaki trousers and white shirt, warm casual portrait', category: 'avatar', theme: 'casual' },
	{ prompt: 'a south asian woman in a salwar kameez with a dupatta, traditional everyday casual portrait', category: 'avatar', theme: 'casual' },

	// Subculture & creative
	{ prompt: 'a white man with sleeve tattoos in a black band tee, straight-leg black jeans and combat boots, rock portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'a black woman in a pastel goth outfit, lavender hair, layered skirt and platform shoes, alt fashion portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'an east asian man with bleached hair in a y2k outfit, baggy low-rise jeans and a slim mesh top, fashion portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'a latina woman in a vintage 90s windbreaker, bike shorts and chunky sneakers, retro streetwear portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'a white skateboarder in a loose polo shirt, wide-leg cords and skate shoes, cap turned backwards, portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'a black man in a dashiki and linen trousers, wooden bead necklace, natural hair, cultural portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'an asian woman in a full harajuku coord with layered accessories, knee socks and platforms, portrait', category: 'avatar', theme: 'subculture' },
	{ prompt: 'a south asian woman in a modern fusion sari-draped outfit, street fashion editorial portrait', category: 'avatar', theme: 'subculture' },

	// Professions & trades — the working world, in uniform
	{ prompt: 'a black woman firefighter in full turnout gear with reflective stripes and a helmet under one arm', category: 'avatar', theme: 'profession' },
	{ prompt: 'an east asian man chef in a double-breasted white jacket, check trousers and a folded apron', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white woman airline pilot in a navy uniform with epaulettes and a peaked cap', category: 'avatar', theme: 'profession' },
	{ prompt: 'a hispanic man construction worker in a hi-vis vest, hard hat, tool belt and work boots', category: 'avatar', theme: 'profession' },
	{ prompt: 'a south asian woman surgeon in teal scrubs, cap and clogs, mask pulled down around the neck', category: 'avatar', theme: 'profession' },
	{ prompt: 'a black man train conductor in a dark uniform coat with brass buttons and a flat cap', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white man auto mechanic in navy coveralls with rolled sleeves and a shop rag in the pocket', category: 'avatar', theme: 'profession' },
	{ prompt: 'a middle eastern woman architect in a crisp white shirt, wide trousers and a canvas tube bag', category: 'avatar', theme: 'profession' },
	{ prompt: 'an east asian woman barista in a denim apron over a plain tee, sleeves pushed up', category: 'avatar', theme: 'profession' },
	{ prompt: 'a black woman scientist in a white lab coat over a knit top, safety glasses pushed up on the head', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white woman farmer in a waxed jacket, work jeans and rubber boots with a wide-brim hat', category: 'avatar', theme: 'profession' },
	{ prompt: 'a latino man commercial fisherman in bright orange waterproof bibs and a wool beanie', category: 'avatar', theme: 'profession' },
	{ prompt: 'a south asian man tailor in a fitted waistcoat and shirtsleeves with a measuring tape around the neck', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white man carpenter in a canvas apron over a flannel shirt, pencil behind the ear', category: 'avatar', theme: 'profession' },
	{ prompt: 'a black man paramedic in a green high-visibility jumpsuit with a shoulder radio', category: 'avatar', theme: 'profession' },
	{ prompt: 'an east asian woman ceramicist in a clay-streaked linen apron with hair tied back', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white woman veterinarian in navy scrubs and a fleece vest with a stethoscope', category: 'avatar', theme: 'profession' },
	{ prompt: 'a middle eastern man baker in a flour-dusted white apron and rolled-up sleeves', category: 'avatar', theme: 'profession' },
	{ prompt: 'a black woman electrician in a utility jumpsuit with an insulated tool pouch and gloves', category: 'avatar', theme: 'profession' },
	{ prompt: 'a hispanic woman park ranger in an olive uniform shirt, brimmed hat and radio harness', category: 'avatar', theme: 'profession' },
	{ prompt: 'a white man welder in a leather apron, heavy gloves and a flip-up welding mask on the forehead', category: 'avatar', theme: 'profession' },
	{ prompt: 'a south asian woman flight attendant in a tailored uniform dress with a neck scarf', category: 'avatar', theme: 'profession' },
	{ prompt: 'an east asian man deep sea diver in a neoprene wetsuit with a buoyancy vest and mask on the forehead', category: 'avatar', theme: 'profession' },
	{ prompt: 'a black man photographer in a utility vest over a hoodie with a camera strap across the chest', category: 'avatar', theme: 'profession' },

	// Fantasy — humanoid heroes, clean silhouettes
	{ prompt: 'a knight in polished steel plate armour with a surcoat and a longsword sheathed at the hip', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female elf ranger in layered green leather armour with a quiver and a braided side plait', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a dwarf blacksmith in a heavy leather apron over chainmail with a braided beard', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a wizard in deep blue embroidered robes with a rune-carved staff and a long white beard', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female battle cleric in white and gold plate with a tabard and a heavy round shield', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a hooded rogue in dark layered leathers with buckled straps and twin daggers at the belt', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a barbarian warrior in fur-trimmed hide armour with painted war markings and a great axe', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female druid in a moss-green cloak with wooden bead jewellery and a carved oak staff', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a desert nomad warrior in flowing sand-coloured robes with wrapped forearms and a curved blade', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female pirate captain in a long coat with a wide belt, tricorn hat and tall cuffed boots', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a samurai in lacquered lamellar armour with a shoulder guard and a katana at the waist', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female monk in simple saffron wrapped robes with a rope belt and bare forearms', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a viking shieldmaiden in a riveted mail shirt with a fur mantle and a round painted shield', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a plague doctor in a long waxed coat, wide-brim hat and a beaked leather mask', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female sorceress in a flowing violet gown with gold arm cuffs and a crystal pendant', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a forest hunter in a fur-lined hood and layered wool tunic with a longbow across the back', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a royal guard in ceremonial gold-trimmed armour with a tall plumed helmet and a spear', category: 'avatar', theme: 'fantasy' },
	{ prompt: 'a female alchemist in a leather harness over a linen shirt with vial pouches and goggles', category: 'avatar', theme: 'fantasy' },

	// Sci-fi — hard surfaces read well in reconstruction
	{ prompt: 'an astronaut in a white hard-shell spacesuit with a gold-visored helmet and chest control panel', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female deep-space engineer in a padded orange flight suit with utility straps and heavy boots', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a cyberpunk courier in a black techwear jacket with reflective panels and a segmented backpack', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female android in a matte white ceramic exosuit with visible joint seams and glowing blue accents', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a heavy power-armour soldier in matte grey armoured plating with shoulder pauldrons', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female colony medic in a light blue hazard suit with a transparent visor and a shoulder kit', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a mech pilot in a fitted flight harness over a padded bodysuit with a headset collar', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female bounty hunter in worn composite armour with a patched cape and a utility belt', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a desert scavenger in wrapped cloth over a mismatched armour rig with tinted goggles', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female orbital station technician in a grey jumpsuit with magnetic boots and a tool harness', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a stealth operative in a sleek dark bodysuit with a slim chest rig and a low-profile visor', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female starship captain in a structured uniform jacket with rank piping and tall boots', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a biodome researcher in a sealed white containment suit with a backpack filtration unit', category: 'avatar', theme: 'scifi' },
	{ prompt: 'a female drone operator in a padded flight vest over a technical hoodie with a wrist console', category: 'avatar', theme: 'scifi' },

	// Historical & cultural dress
	{ prompt: 'a roman legionary in segmented armour with a red tunic, rectangular shield and crested helmet', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in an edwardian walking dress with a high collar, fitted jacket and long skirt', category: 'avatar', theme: 'historical' },
	{ prompt: 'a 1920s jazz musician in a pinstripe three-piece suit with a fedora and two-tone shoes', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a 1950s swing dress with a cinched waist, petticoat and kitten heels', category: 'avatar', theme: 'historical' },
	{ prompt: 'an american frontier ranch hand in a duster coat, wide-brim hat and leather chaps', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a hand-embroidered mexican folk dress with a wide sash and braided hair ribbons', category: 'avatar', theme: 'historical' },
	{ prompt: 'a man in a highland kilt with a tweed jacket, sporran and knee socks', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a layered japanese kimono with an obi sash and wooden sandals', category: 'avatar', theme: 'historical' },
	{ prompt: 'a west african man in a flowing embroidered agbada robe with a matching cap', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a bright andean woven skirt with layered shawls and a bowler hat', category: 'avatar', theme: 'historical' },
	{ prompt: 'a man in a korean hanbok with a wide-sleeved jacket and full trousers', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a scandinavian folk costume with an embroidered bodice, apron and silver brooch', category: 'avatar', theme: 'historical' },
	{ prompt: 'a 1970s musician in a wide-lapel corduroy suit with a patterned shirt and platform boots', category: 'avatar', theme: 'historical' },
	{ prompt: 'a woman in a 1980s power blazer with shoulder pads, a pencil skirt and bold earrings', category: 'avatar', theme: 'historical' },

	// Stylized — non-photoreal art directions that still rig cleanly
	{ prompt: 'a stylized cartoon adventurer with exaggerated proportions, a big backpack and chunky boots', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a chibi-proportioned schoolgirl character with a large head, small body and a pleated skirt', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a clay-sculpted stop-motion style character in a knitted sweater with visible fingerprint texture', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a low-poly flat-shaded traveller character in a bright jacket with faceted geometry', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a cel-shaded anime swordsman with spiky hair, a long coat and bold outlines', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a soft vinyl toy style character with glossy plastic skin, oversized shoes and simple features', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a papercraft-styled explorer character with folded planar surfaces and matte paper texture', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a stylized pixar-like hero with rounded features, a fitted vest and expressive posture', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a knitted wool doll character with visible stitching, button eyes and a striped scarf', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a stylized cyber-ninja with a smooth featureless mask, a sculpted bodysuit and a wrapped sash', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a wooden articulated artist mannequin figure with visible ball joints and grain texture', category: 'avatar', theme: 'stylized' },
	{ prompt: 'a stylized retro-futurist robot butler with a rounded chrome body, bow tie and jointed arms', category: 'avatar', theme: 'stylized' },

	// Performance & stage
	{ prompt: 'a ballet dancer in a fitted leotard, wrap skirt and pointe shoes with hair in a bun', category: 'avatar', theme: 'performance' },
	{ prompt: 'a circus ringmaster in a red tailcoat, top hat and high polished boots', category: 'avatar', theme: 'performance' },
	{ prompt: 'a stage magician in a black tuxedo with a satin-lined cape and white gloves', category: 'avatar', theme: 'performance' },
	{ prompt: 'a rock singer in a studded leather jacket, ripped jeans and heeled boots with a mic stand', category: 'avatar', theme: 'performance' },
	{ prompt: 'a mime performer in a striped shirt, suspenders and white face paint', category: 'avatar', theme: 'performance' },
	{ prompt: 'a female opera singer in a floor-length beaded gown with long gloves', category: 'avatar', theme: 'performance' },
	{ prompt: 'a street breakdancer in a tracksuit and snapback with knee pads and clean sneakers', category: 'avatar', theme: 'performance' },
	{ prompt: 'a carnival dancer in a feathered headdress and sequinned costume with beaded fringe', category: 'avatar', theme: 'performance' },

	// ── ACCESSORIES — real-world wearables & carried items ───────────────────

	// Footwear
	{ prompt: 'a pair of classic white low-top leather sneakers with clean soles and minimal branding, product shot', category: 'accessory', theme: 'sneakers' },
	{ prompt: 'a pair of retro chunky-sole basketball sneakers in black and gold, bold silhouette, product shot', category: 'accessory', theme: 'sneakers' },
	{ prompt: 'a pair of worn brown leather chelsea boots with elastic side panels and a stacked heel', category: 'accessory', theme: 'boots' },
	{ prompt: 'a pair of strappy black leather heeled sandals with an ankle buckle, elegant product shot', category: 'accessory', theme: 'heels' },
	{ prompt: 'a pair of high-top canvas sneakers in off-white with black rubber toe cap', category: 'accessory', theme: 'sneakers' },
	{ prompt: 'a pair of sleek black leather oxford dress shoes with a cap-toe detail and leather sole', category: 'accessory', theme: 'dress-shoes' },
	{ prompt: 'a pair of white athletic running shoes with a mesh upper and foam midsole, sport product shot', category: 'accessory', theme: 'sneakers' },
	{ prompt: 'a pair of tan suede lace-up desert boots with a crepe sole', category: 'accessory', theme: 'boots' },

	// Bags & carriers
	{ prompt: 'a structured black leather tote bag with gold hardware, top handles and a detachable strap', category: 'accessory', theme: 'bag' },
	{ prompt: 'a slim brown leather messenger bag with a buckle flap, adjustable strap and multiple pockets', category: 'accessory', theme: 'bag' },
	{ prompt: 'a canvas and leather trim backpack in tan with a laptop sleeve and brass buckles', category: 'accessory', theme: 'bag' },
	{ prompt: 'a small quilted black leather crossbody bag with a gold chain strap, luxury style product shot', category: 'accessory', theme: 'bag' },
	{ prompt: 'a sporty nylon drawstring gym bag in black with a side bottle pocket', category: 'accessory', theme: 'bag' },
	{ prompt: 'a woven straw summer tote with leather handles and a striped lining, beach bag', category: 'accessory', theme: 'bag' },

	// Outerwear
	{ prompt: 'a classic tan trench coat laid flat, double-breasted with belt and epaulettes, clean product shot', category: 'accessory', theme: 'jacket' },
	{ prompt: 'a worn brown leather biker jacket with silver zips and a pointed lapel collar', category: 'accessory', theme: 'jacket' },
	{ prompt: 'a quilted black puffer jacket with a high collar and elastic cuffs, puffer product shot', category: 'accessory', theme: 'jacket' },
	{ prompt: 'a relaxed oversized grey wool overcoat with wide lapels and deep pockets', category: 'accessory', theme: 'jacket' },
	{ prompt: 'a varsity jacket in navy and white with leather sleeves and ribbed trim', category: 'accessory', theme: 'jacket' },
	{ prompt: 'a lightweight olive field jacket with multiple flap pockets and a hood', category: 'accessory', theme: 'jacket' },

	// Headwear
	{ prompt: 'a structured fitted black baseball cap with a curved brim and embroidered logo on front', category: 'accessory', theme: 'hat' },
	{ prompt: 'a cream ribbed beanie with a fold-up cuff, soft knit texture, product shot', category: 'accessory', theme: 'hat' },
	{ prompt: 'a wide-brim sun hat in natural straw with a black grosgrain band', category: 'accessory', theme: 'hat' },
	{ prompt: 'a black wool beret, classic french style, worn at an angle, product shot', category: 'accessory', theme: 'hat' },
	{ prompt: 'a snapback trucker hat in mesh with a flat brim and front foam patch', category: 'accessory', theme: 'hat' },

	// Jewelry & watches
	{ prompt: 'a chunky gold rope chain necklace with a box clasp, heavy links, luxury product shot', category: 'accessory', theme: 'jewelry' },
	{ prompt: 'a silver stainless steel watch with a round dial, date window and mesh bracelet', category: 'accessory', theme: 'watch' },
	{ prompt: 'a pair of large gold hoop earrings with a polished finish, classic style', category: 'accessory', theme: 'jewelry' },
	{ prompt: 'a wide gold cuff bracelet with a hammered texture and polished edges', category: 'accessory', theme: 'jewelry' },
	{ prompt: 'a black rubber sport watch with a chunky case, tachymeter bezel and digital display', category: 'accessory', theme: 'watch' },
	{ prompt: 'a stack of thin gold rings in varying widths, laid flat, minimalist jewelry product shot', category: 'accessory', theme: 'jewelry' },
	{ prompt: 'a pearl strand necklace with a gold clasp, classic length, clean product shot', category: 'accessory', theme: 'jewelry' },
	{ prompt: 'a silver tennis bracelet with clear stones set in a row, elegant product shot', category: 'accessory', theme: 'jewelry' },

	// Eyewear
	{ prompt: 'a pair of classic tortoiseshell wayfarer sunglasses with dark lenses, product shot', category: 'accessory', theme: 'eyewear' },
	{ prompt: 'a pair of slim gold wire-frame round glasses with clear lenses', category: 'accessory', theme: 'eyewear' },
	{ prompt: 'a pair of oversized square black sunglasses with gradient lenses, fashion eyewear product shot', category: 'accessory', theme: 'eyewear' },
	{ prompt: 'a pair of sporty wraparound sunglasses in black with mirrored lenses', category: 'accessory', theme: 'eyewear' },

	// Everyday carry
	{ prompt: 'a slim bifold wallet in black pebbled leather with card slots visible, product shot', category: 'accessory', theme: 'carry' },
	{ prompt: 'a matte black phone case with a card slot on the back, minimal design', category: 'accessory', theme: 'carry' },
	{ prompt: 'a stainless steel insulated water bottle in matte black with a loop cap', category: 'accessory', theme: 'carry' },
	{ prompt: 'a pair of white wireless over-ear headphones with padded cushions and a folding frame', category: 'accessory', theme: 'carry' },
	{ prompt: 'a clean white airpods case with glossy finish, small product shot', category: 'accessory', theme: 'carry' },
	{ prompt: 'a vintage-style zippo lighter in brushed silver with a flip lid, product shot', category: 'accessory', theme: 'carry' },

	// Scarves, belts & other
	{ prompt: 'a cashmere scarf in camel plaid, loosely folded to show the fringe ends, product shot', category: 'accessory', theme: 'scarf' },
	{ prompt: 'a wide leather belt in cognac brown with a silver square buckle', category: 'accessory', theme: 'belt' },
	{ prompt: 'a silk pocket square in a deep burgundy paisley pattern, folded in a TV fold', category: 'accessory', theme: 'accessory' },
	{ prompt: 'a pair of black leather gloves with a cashmere lining, classic style, product shot', category: 'accessory', theme: 'gloves' },

	// Tools & workshop
	{ prompt: 'a claw hammer with a hickory handle and a forged steel head, studio product shot', category: 'accessory', theme: 'tool' },
	{ prompt: 'a cordless power drill in matte black and yellow with a chuck and battery pack', category: 'accessory', theme: 'tool' },
	{ prompt: 'an adjustable steel wrench with a knurled thumb wheel and a worn chrome finish', category: 'accessory', theme: 'tool' },
	{ prompt: 'a red steel toolbox with a folding handle and two latching clasps, closed', category: 'accessory', theme: 'tool' },
	{ prompt: 'a wooden-handled hand plane with a brass adjustment knob and a steel blade', category: 'accessory', theme: 'tool' },
	{ prompt: 'a pair of heavy-duty bolt cutters with long red rubber grips', category: 'accessory', theme: 'tool' },

	// Musical instruments
	{ prompt: 'a sunburst electric guitar with chrome hardware and a maple neck, product shot', category: 'accessory', theme: 'instrument' },
	{ prompt: 'a brass trumpet with three valves and a flared bell, polished lacquer finish', category: 'accessory', theme: 'instrument' },
	{ prompt: 'a wooden acoustic violin with an ebony fingerboard and a shaped bridge', category: 'accessory', theme: 'instrument' },
	{ prompt: 'a compact snare drum with a chrome shell, tension rods and a coated head', category: 'accessory', theme: 'instrument' },
	{ prompt: 'a pair of studio headphones on a folding steel headband with leather ear cups', category: 'accessory', theme: 'instrument' },

	// Sports & outdoor gear
	{ prompt: 'a leather american football with raised white laces and a pebbled surface', category: 'accessory', theme: 'sports' },
	{ prompt: 'an orange basketball with deep black seams and a dimpled rubber surface', category: 'accessory', theme: 'sports' },
	{ prompt: 'a black and white panelled soccer ball with a matte finish', category: 'accessory', theme: 'sports' },
	{ prompt: 'a matte black bicycle helmet with vent channels and an adjustable dial at the rear', category: 'accessory', theme: 'sports' },
	{ prompt: 'a wooden skateboard deck with metal trucks and orange urethane wheels, underside up', category: 'accessory', theme: 'sports' },
	{ prompt: 'a rolled camping sleeping bag in dark green with a compression strap', category: 'accessory', theme: 'sports' },
	{ prompt: 'a hiking backpack in slate blue with external straps, a hip belt and a top lid pocket', category: 'accessory', theme: 'sports' },
	{ prompt: 'a pair of red boxing gloves with white laces and a padded wrist cuff', category: 'accessory', theme: 'sports' },

	// Home & desk objects
	{ prompt: 'a ceramic mug in matte speckled grey with a rounded handle, studio product shot', category: 'accessory', theme: 'home' },
	{ prompt: 'a brass desk lamp with an articulated arm and a domed shade', category: 'accessory', theme: 'home' },
	{ prompt: 'a stack of three hardcover books with cloth-bound spines and gilt lettering', category: 'accessory', theme: 'home' },
	{ prompt: 'a hand-thrown stoneware vase with a wide belly and a narrow neck, glazed in deep blue', category: 'accessory', theme: 'home' },
	{ prompt: 'a vintage rotary telephone in cream bakelite with a coiled cord and a metal dial', category: 'accessory', theme: 'home' },
	{ prompt: 'a wooden chess knight piece carved with a flowing mane on a felt-lined base', category: 'accessory', theme: 'home' },

	// Sculpted animal props — display figures, not rigged creatures
	{ prompt: 'a carved wooden elephant figurine standing on all four legs with detailed grain', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a polished bronze horse statuette rearing on a rectangular plinth', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a ceramic sitting cat figurine in glossy white with painted eyes', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a stone owl garden statue perched on a short post with weathered texture', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a resin model of a coiled dragon with layered scales on a rocky base', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a painted wooden duck decoy with a smooth body and glass eyes', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a jade carved turtle ornament with an engraved shell pattern', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a plush teddy bear with stitched paw pads, a fabric nose and a ribbon bow', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a detailed resin model of a standing wolf with a thick fur coat on a snow base', category: 'accessory', theme: 'creature-prop' },
	{ prompt: 'a small brass rabbit paperweight with polished ears and a matte body', category: 'accessory', theme: 'creature-prop' },
];

// Framing directives appended to every AVATAR prompt before generation.
//
// A catalog avatar exists to be animated: the auto-rigger needs the whole body
// visible, arms clear of the torso, and a neutral standing stance to place a
// humanoid skeleton. Left to itself the text→image stage happily returns a
// waist-up "studio portrait" (many of the original prompts literally say
// "portrait"), which reconstructs into a half-body bust that can never rig. This
// suffix is the one place that bar is enforced, so a prompt author never has to
// remember it.
export const AVATAR_FRAMING =
	'full body visible from head to feet, standing straight and facing the camera, ' +
	'arms relaxed slightly away from the torso, hands open with fingers separated, ' +
	'feet flat and shoulder width apart, plain seamless studio background, even lighting, single subject';

// Framing for accessory / prop subjects: isolated, grounded, no scene.
export const ACCESSORY_FRAMING =
	'single object centered in frame, plain seamless studio background, even lighting, no hands, no people';

// Render a library entry into the exact string sent to /api/forge. Idempotent by
// construction (the framing text is never part of the stored prompt), so the
// cron's "recently used" de-duplication still keys on the library string.
/** @param {SeedPrompt} entry */
export function composeSeedPrompt(entry) {
	const base = String(entry?.prompt || '').trim();
	if (!base) return '';
	const framing = entry?.category === 'accessory' ? ACCESSORY_FRAMING : AVATAR_FRAMING;
	return `${base}, ${framing}`;
}

// Deterministic id for a prompt — the batch runner's checkpoint key and the
// avatar slug seed. Stable across runs because it is derived from the prompt
// text itself, so re-running a batch never re-generates a completed item.
/** @param {SeedPrompt} entry */
export function seedPromptId(entry) {
	const base = String(entry?.prompt || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	// FNV-1a over the full prompt: short, collision-safe enough for a few
	// thousand entries, and needs no crypto import in either runtime.
	let hash = 0x811c9dc5;
	const text = String(entry?.prompt || '');
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${base.slice(0, 48)}-${hash.toString(16).padStart(8, '0')}`;
}

// OG username pool — short common English words that look like someone grabbed
// them on day one. The cron tries the bare word first; if taken it appends an
// incrementing number (wolf2, wolf3 …) to stay unique without looking synthetic.
export const OG_USERNAMES = [
	// nature & landscape
	'wolf', 'raven', 'storm', 'frost', 'ember', 'ash', 'coal', 'oak', 'pine',
	'river', 'dawn', 'dusk', 'tide', 'moon', 'star', 'mist', 'fog', 'rain',
	'snow', 'ice', 'fire', 'wind', 'rock', 'stone', 'leaf', 'moss', 'reed',
	'fern', 'thorn', 'briar', 'gale', 'vale', 'glen', 'moor', 'fen', 'dale',
	'crag', 'ford', 'holt', 'shaw', 'mere', 'fell', 'tor', 'holm', 'ridge',
	'cliff', 'coast', 'cove', 'cape', 'bluff', 'gorge', 'plain', 'peak', 'pass',
	'dune', 'delta', 'shoal', 'reef', 'knoll', 'heath', 'marsh', 'grove',
	// animals
	'fox', 'bear', 'hawk', 'elk', 'owl', 'crane', 'deer', 'lynx', 'boar',
	'crow', 'viper', 'ram', 'bull', 'drake', 'kite', 'wren', 'heron', 'pike',
	'bison', 'moose', 'puma', 'ibex', 'colt', 'finch', 'trout', 'swift',
	// materials & qualities
	'iron', 'gold', 'silver', 'bronze', 'steel', 'flint', 'slate', 'amber',
	'jade', 'onyx', 'opal', 'pearl', 'ivory', 'chalk', 'clay', 'sable',
	'bold', 'dark', 'bright', 'deep', 'still', 'sharp', 'keen', 'wild', 'true',
	'pure', 'lone', 'free', 'vast', 'grim', 'grit', 'calm',
	// verbs used as handles
	'forge', 'craft', 'carve', 'cast', 'weld', 'spark', 'flame', 'glow',
	'drift', 'burn', 'rise', 'hunt', 'seek', 'hold', 'draw', 'mark', 'cut',
	'form', 'mend', 'bind', 'wave', 'flow', 'run',
	// sky & cosmos
	'comet', 'nova', 'void', 'flare', 'pulse', 'orbit', 'zenith', 'apex',
	'beam', 'arc', 'flux', 'ray', 'haze', 'veil', 'shade', 'glare',
	// misc
	'ridge', 'rill', 'beck', 'loch', 'tarn', 'down', 'sward', 'brae',
	'copse', 'weald', 'wold', 'brake',
];
