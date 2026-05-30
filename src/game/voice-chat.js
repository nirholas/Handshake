// Spatial voice chat for Coin Communities — talk to the people standing near you.
//
// This is what makes a coin community feel like a real gathering instead of a
// chat box with avatars: walk up to someone and you hear them, drift away and
// they fade out, and their voice comes from their direction in the world.
//
// Design — a PROXIMITY-GATED WebRTC MESH:
//   • Audio is peer-to-peer (WebRTC). The Colyseus room is only a signaling
//     relay for SDP/ICE; it never carries audio.
//   • We open a connection only to peers within earshot, and tear it down when
//     they walk away. That bounds the mesh no matter how big the room gets AND
//     is exactly what spatial audio needs — you only need audio from people you
//     can hear.
//   • Each remote's audio runs through a Web Audio PannerNode positioned at
//     their world coordinates, with the listener pinned to the local avatar and
//     oriented by the camera. Distance attenuation (linear, silent past
//     MAX_DISTANCE) makes proximity legible by ear.
//   • Only the lower sessionId in a pair sends the offer, so two peers coming
//     into range at once never glare. The `voice` player flag (synced via the
//     room) tells us who's actually in voice, so we never dial someone who
//     can't answer.
//
// The scene owns the per-frame update (positions) and lifecycle; this module
// owns the microphone, the peer connections, and the audio graph.

// Proximity thresholds, in metres. CONNECT a little outside the audible edge so
// the handshake completes before someone is fully in earshot; DISCONNECT with
// hysteresis so a peer pacing the boundary doesn't thrash connections.
const CONNECT_RANGE = 27;
const DISCONNECT_RANGE = 33;

// Panner distance model: full volume within REF_DISTANCE, linearly down to
// silence at MAX_DISTANCE. Linear (not inverse) so walking past the edge is a
// clean fade to nothing rather than a never-quite-zero tail.
const REF_DISTANCE = 3;
const MAX_DISTANCE = 26;

// Voice-activity threshold (RMS of the time-domain signal) for the "speaking"
// indicator. Tuned to ignore room tone / breathing but catch normal speech.
const SPEAK_THRESHOLD = 0.018;
const METER_INTERVAL_MS = 120;

// Public STUN. A coin community can supply its own TURN servers (needed for
// peers behind symmetric NAT) by setting window.__VOICE_ICE__ to an array of
// RTCIceServer entries — real config, no placeholder credentials baked in.
function iceServers() {
	const base = [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' },
	];
	const extra = (typeof window !== 'undefined' && Array.isArray(window.__VOICE_ICE__)) ? window.__VOICE_ICE__ : null;
	return extra && extra.length ? base.concat(extra) : base;
}

// True when the browser can actually run spatial voice. The mic button stays
// disabled (with an explanation) when this is false.
export function voiceSupported() {
	return typeof RTCPeerConnection !== 'undefined'
		&& typeof navigator !== 'undefined'
		&& !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
		&& (typeof AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined');
}

export class VoiceChat {
	/**
	 * @param {object} o
	 * @param {string}   o.selfId          our Colyseus sessionId (decides who dials)
	 * @param {Function} o.sendSignal       (to, data) → relay SDP/ICE to one peer
	 * @param {Function} [o.onStateChange]  (state) → 'off'|'on'|'muted'
	 * @param {Function} [o.onPeerSpeaking] (peerId, speaking)
	 * @param {Function} [o.onLocalSpeaking](speaking)
	 */
	constructor(o) {
		this.selfId = o.selfId;
		this.sendSignal = o.sendSignal;
		this.onStateChange = o.onStateChange;
		this.onPeerSpeaking = o.onPeerSpeaking;
		this.onLocalSpeaking = o.onLocalSpeaking;

		this.peers = new Map(); // peerId → { pc, panner, analyser, audioEl, source, data, speaking }
		this.ctx = null;
		this.listener = null;
		this.localStream = null;
		this.localTrack = null;
		this.localAnalyser = null;
		this.localData = null;
		this.joined = false;
		this._state = 'off';
		this._localSpeaking = false;
		this._meterAt = 0;
	}

	get state() { return this._state; }

	_setState(s) {
		if (s === this._state) return;
		this._state = s;
		this.onStateChange?.(s);
	}

	// Capture the mic and open the audio graph. Must be called from a user
	// gesture (the mic button) so getUserMedia + AudioContext are allowed to
	// start. Throws on permission denial / no device — the caller surfaces it.
	async join() {
		if (this.joined) return this._state;
		const Ctx = window.AudioContext || window.webkitAudioContext;
		this.ctx = new Ctx();
		if (this.ctx.state === 'suspended') await this.ctx.resume();
		this.localStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			video: false,
		});
		this.localTrack = this.localStream.getAudioTracks()[0] || null;

		// Meter our own mic so we can show the local "speaking" pulse. This tap is
		// analysis-only — it's never connected to the output.
		const lsrc = this.ctx.createMediaStreamSource(this.localStream);
		this.localAnalyser = this.ctx.createAnalyser();
		this.localAnalyser.fftSize = 512;
		lsrc.connect(this.localAnalyser);
		this.localData = new Float32Array(this.localAnalyser.fftSize);

		this.listener = this.ctx.listener;
		this.joined = true;
		this._setState('on');
		return this._state;
	}

	// Toggle whether our mic is transmitted. Muting keeps every connection open
	// (we still hear everyone) and simply stops sending our audio.
	toggleMute() {
		if (!this.joined || !this.localTrack) return this._state;
		const muting = this._state === 'on';
		this.localTrack.enabled = !muting;
		this._setState(muting ? 'muted' : 'on');
		if (muting && this._localSpeaking) { this._localSpeaking = false; this.onLocalSpeaking?.(false); }
		return this._state;
	}

	// Per-frame from the scene: reposition the listener (local avatar + camera
	// facing) and every peer's panner, open connections to in-range voice peers,
	// and drop ones that walked away.
	// @param {{x,y,z}} selfPos   listener position (local avatar)
	// @param {Array}   peers     [{ id, x, y, z, voice }] of remote players
	// @param {{x,z}}   forward   camera horizontal forward (for L/R panning)
	update(selfPos, peers, forward) {
		if (!this.joined || !this.ctx) return;
		this._setListener(selfPos, forward);

		for (const p of peers) {
			const peer = this.peers.get(p.id);
			const d = Math.hypot(p.x - selfPos.x, (p.y || 0) - (selfPos.y || 0), p.z - selfPos.z);
			if (peer) {
				this._setPanner(peer, p);
				if (!p.voice || d > DISCONNECT_RANGE) this._closePeer(p.id);
			} else if (p.voice && d < CONNECT_RANGE && this.selfId < p.id) {
				// Deterministic initiator: the lower sessionId dials, so two peers
				// entering range simultaneously never both offer.
				this._call(p.id);
			}
		}
		this._meter();
	}

	// Handle a relayed signal from a peer (offer / answer / ICE candidate).
	async onSignal({ from, data }) {
		if (!this.joined || !from || !data) return;
		let peer = this.peers.get(from);
		try {
			if (data.sdp) {
				if (data.sdp.type === 'offer') {
					if (!peer) { peer = this._createPeer(from, false); this._addLocalTracks(peer); }
					await peer.pc.setRemoteDescription(data.sdp);
					const answer = await peer.pc.createAnswer();
					await peer.pc.setLocalDescription(answer);
					this.sendSignal(from, { sdp: peer.pc.localDescription });
				} else if (data.sdp.type === 'answer' && peer) {
					await peer.pc.setRemoteDescription(data.sdp);
				}
			} else if (data.ice && peer) {
				// A candidate can arrive before the remote description is set; ignore
				// the resulting error rather than tear down a healthy connection.
				try { await peer.pc.addIceCandidate(data.ice); } catch { /* premature candidate */ }
			}
		} catch (err) {
			console.warn('[voice] signal handling failed:', err?.message);
		}
	}

	// A peer left the room — drop their connection immediately.
	removePeer(id) { this._closePeer(id); }

	// On a server reconnect every sessionId is reissued, so the old peer
	// connections (and our own id) are stale. Refresh the id and drop every
	// connection; the mesh re-forms from the new ids on the next update().
	setSelfId(id) { this.selfId = id; }
	resetPeers() { for (const id of [...this.peers.keys()]) this._closePeer(id); }

	// Leave voice entirely: close every connection, stop the mic, free the graph.
	dispose() {
		for (const id of [...this.peers.keys()]) this._closePeer(id);
		this.localStream?.getTracks().forEach((t) => t.stop());
		this.localStream = null;
		this.localTrack = null;
		try { this.ctx?.close(); } catch { /* already closed */ }
		this.ctx = null;
		this.joined = false;
		this._setState('off');
	}

	// ---------------------------------------------------------------- internals
	_call(id) {
		const peer = this._createPeer(id, true);
		this._addLocalTracks(peer); // adding tracks fires negotiationneeded → offer
	}

	_addLocalTracks(peer) {
		if (!this.localStream) return;
		for (const t of this.localStream.getTracks()) peer.pc.addTrack(t, this.localStream);
	}

	_createPeer(id, isCaller) {
		const pc = new RTCPeerConnection({ iceServers: iceServers() });

		const panner = this.ctx.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'linear';
		panner.refDistance = REF_DISTANCE;
		panner.maxDistance = MAX_DISTANCE;
		panner.rolloffFactor = 1;
		panner.connect(this.ctx.destination);

		const analyser = this.ctx.createAnalyser();
		analyser.fftSize = 512;

		// A muted <audio> sink keeps the inbound stream "live" so the Web Audio
		// source actually pulls samples (a long-standing Chromium requirement);
		// the audible path is the panner, not this element.
		const audioEl = new Audio();
		audioEl.muted = true;
		audioEl.autoplay = true;

		const peer = { id, pc, panner, analyser, audioEl, source: null, data: new Float32Array(analyser.fftSize), speaking: false };
		this.peers.set(id, peer);

		pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal(id, { ice: e.candidate }); };
		pc.ontrack = (e) => {
			const stream = e.streams[0] || new MediaStream([e.track]);
			audioEl.srcObject = stream;
			audioEl.play?.().catch(() => { /* sink is muted; autoplay is best-effort */ });
			const src = this.ctx.createMediaStreamSource(stream);
			peer.source = src;
			src.connect(panner);
			src.connect(analyser);
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._closePeer(id);
		};
		// Only the caller renegotiates; the callee answers in onSignal, so adding
		// its tracks must not also try to fire an offer (which would glare).
		if (isCaller) {
			pc.onnegotiationneeded = async () => {
				try {
					const offer = await pc.createOffer();
					await pc.setLocalDescription(offer);
					this.sendSignal(id, { sdp: pc.localDescription });
				} catch (err) {
					console.warn('[voice] offer failed:', err?.message);
				}
			};
		}
		return peer;
	}

	_closePeer(id) {
		const peer = this.peers.get(id);
		if (!peer) return;
		this.peers.delete(id);
		try { peer.source?.disconnect(); } catch { /* not connected */ }
		try { peer.panner.disconnect(); } catch { /* not connected */ }
		try { peer.analyser.disconnect(); } catch { /* not connected */ }
		try { peer.pc.close(); } catch { /* already closed */ }
		if (peer.audioEl) peer.audioEl.srcObject = null;
		if (peer.speaking) this.onPeerSpeaking?.(id, false);
	}

	_setPanner(peer, p) {
		const panner = peer.panner;
		const y = p.y || 0;
		if (panner.positionX) {
			panner.positionX.value = p.x;
			panner.positionY.value = y;
			panner.positionZ.value = p.z;
		} else {
			panner.setPosition(p.x, y, p.z); // older Safari
		}
	}

	_setListener(pos, forward) {
		const l = this.listener;
		const fx = forward?.x ?? 0;
		const fz = forward?.z ?? -1;
		const y = pos.y || 0;
		if (l.positionX) {
			l.positionX.value = pos.x; l.positionY.value = y; l.positionZ.value = pos.z;
			l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = fz;
			l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
		} else {
			l.setPosition(pos.x, y, pos.z); // older Safari
			l.setOrientation(fx, 0, fz, 0, 1, 0);
		}
	}

	// Throttled voice-activity detection for the speaking indicators.
	_meter() {
		const now = (typeof performance !== 'undefined' ? performance.now() : 0);
		if (now - this._meterAt < METER_INTERVAL_MS) return;
		this._meterAt = now;

		if (this.localAnalyser) {
			const sp = this._state === 'on' && this._rms(this.localAnalyser, this.localData) > SPEAK_THRESHOLD;
			if (sp !== this._localSpeaking) { this._localSpeaking = sp; this.onLocalSpeaking?.(sp); }
		}
		for (const peer of this.peers.values()) {
			if (!peer.source) continue;
			const sp = this._rms(peer.analyser, peer.data) > SPEAK_THRESHOLD;
			if (sp !== peer.speaking) { peer.speaking = sp; this.onPeerSpeaking?.(peer.id, sp); }
		}
	}

	_rms(analyser, buf) {
		analyser.getFloatTimeDomainData(buf);
		let sum = 0;
		for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
		return Math.sqrt(sum / buf.length);
	}
}
