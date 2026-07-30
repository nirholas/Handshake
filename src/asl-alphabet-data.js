// The manual alphabet, described in words.
// ========================================
// The engine knows the HANDSHAPE for every letter (src/sign-handshapes.js);
// this file is the human half: what a reader should look for, and the letters
// each one is confused with. Descriptions follow the standard teaching
// descriptions of the American manual alphabet, written for someone who has
// never fingerspelled.
//
// `motion: true` marks the two letters that are traced rather than held (J and
// Z), and `look` is the pairing note the page shows so a learner knows which
// letters they will mix up.

/** @type {Record<string, { hand: string, look?: string, motion?: boolean }>} */
export const LETTER_NOTES = Object.freeze({
	A: { hand: 'Closed fist, thumb resting straight along the side of the index finger.', look: 'Against S: the A thumb sits beside the fist, the S thumb crosses in front of it.' },
	B: { hand: 'Flat hand, four fingers straight up and together, thumb folded across the palm.', look: 'Against 4: B tucks the thumb in, 4 leaves it out.' },
	C: { hand: 'Fingers and thumb curved into the shape of the letter C, palm to the side.', look: 'Against O: C stays open, O closes the gap.' },
	D: { hand: 'Index finger straight up; the other fingers meet the thumb in a circle beneath it.', look: 'Against 1: D adds the circle of fingers under the raised index.' },
	E: { hand: 'Fingers curled down onto the flat thumb, fingertips touching it.', look: 'Against S and A: E shows curled fingertips rather than a solid fist.' },
	F: { hand: 'Index finger and thumb touch in a circle; the other three fingers stand up.', look: 'Against 9: the same shape, so context tells them apart.' },
	G: { hand: 'Index finger and thumb held parallel, pointing sideways, a small gap between them.', look: 'Against Q: G points sideways, Q points down.' },
	H: { hand: 'Index and middle fingers together, pointing sideways.', look: 'Against U: H lies sideways, U points up.' },
	I: { hand: 'Fist with only the little finger raised.', look: 'Against Y: I raises the pinky alone, Y adds the thumb.' },
	J: { hand: 'The I handshape traces the letter J through the air.', look: 'The motion is the letter: without it, J reads as I.', motion: true },
	K: { hand: 'Index and middle fingers up in a V, thumb pressed between them.', look: 'Against V: K sets the thumb into the fork.' },
	L: { hand: 'Index finger up and thumb out, making a right angle.', look: 'Unmistakable, and the easiest letter to teach first.' },
	M: { hand: 'Thumb tucked under the first three fingers, which fold over it.', look: 'Against N: M covers the thumb with three fingers, N with two.' },
	N: { hand: 'Thumb tucked under the first two fingers, which fold over it.', look: 'Against M: count the fingers over the thumb.' },
	O: { hand: 'Fingers and thumb curve together into a closed circle.', look: 'Against C: O closes, C leaves a gap.' },
	P: { hand: 'The K handshape rotated to point down.', look: 'Against K: same fingers, different direction.' },
	Q: { hand: 'The G handshape rotated to point down.', look: 'Against G: same fingers, different direction.' },
	R: { hand: 'Index and middle fingers crossed, standing up.', look: 'Against U and V: R crosses the fingers instead of parting them.' },
	S: { hand: 'Closed fist, thumb crossing in front of the folded fingers.', look: 'Against A: the thumb crosses the fingers rather than resting beside them.' },
	T: { hand: 'Thumb tucked between the index and middle fingers of a fist.', look: 'Against N: T pushes the thumb up between the first two fingers.' },
	U: { hand: 'Index and middle fingers straight up and together.', look: 'Against V: U keeps the fingers together, V spreads them.' },
	V: { hand: 'Index and middle fingers straight up, spread apart.', look: 'Against U and 2: the shape is the same as 2, read from context.' },
	W: { hand: 'Index, middle and ring fingers up and spread; thumb holds the little finger.', look: 'Against 6: the same shape, read from context.' },
	X: { hand: 'Fist with the index finger raised and hooked.', look: 'Against 1: X hooks the finger instead of holding it straight.' },
	Y: { hand: 'Fist with the thumb and little finger extended.', look: 'Against I: Y adds the thumb.' },
	Z: { hand: 'The index finger draws the letter Z in the air.', look: 'The motion is the letter: without it, Z reads as 1.', motion: true },
	0: { hand: 'Fingers and thumb form a closed circle, palm forward.', look: 'Against O: the number faces the reader.' },
	1: { hand: 'Index finger straight up, the rest closed.', look: 'Against D and X: 1 keeps the finger straight and free.' },
	2: { hand: 'Index and middle fingers up and spread.', look: 'Shares its shape with V.' },
	3: { hand: 'Thumb, index and middle fingers extended.', look: 'Against 6 and W: count the extended fingers.' },
	4: { hand: 'Four fingers up and spread, thumb across the palm.', look: 'Against B: 4 spreads the fingers.' },
	5: { hand: 'All five fingers spread, palm forward.', look: 'The open hand: the shape most other letters start from.' },
	6: { hand: 'Little finger and thumb touch; the other three fingers stand up.', look: 'Shares its shape with W.' },
	7: { hand: 'Ring finger and thumb touch; the other fingers stand up.', look: 'Against 8: 7 uses the ring finger, 8 the middle.' },
	8: { hand: 'Middle finger and thumb touch; the other fingers stand up.', look: 'Against 7: check which finger meets the thumb.' },
	9: { hand: 'Index finger and thumb touch in a circle; the other fingers stand up.', look: 'Shares its shape with F.' },
});

/** Letters in the order the page lays them out. */
export const LETTERS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

/** Digits in the order the page lays them out. */
export const DIGITS = Object.freeze('0123456789'.split(''));

/** Words the practice mode draws from: short, common, and worth spelling. */
export const PRACTICE_WORDS = Object.freeze([
	'HELLO', 'NAME', 'FRIEND', 'COFFEE', 'MUSIC', 'SUMMER', 'ORANGE', 'PLANET',
	'GARDEN', 'YELLOW', 'WINDOW', 'SILVER', 'PURPLE', 'CANDLE', 'MARKET', 'RIVER',
]);
