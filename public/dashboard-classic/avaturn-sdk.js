function e(t, s) {
	return (
		(e = Object.setPrototypeOf
			? Object.setPrototypeOf.bind()
			: function (e, t) {
					return (e.__proto__ = t), e;
				}),
		e(t, s)
	);
}
var t, s;
!(function (e) {
	(e.AuthError = 'auth_error'),
		(e.AvatarLoadError = 'avatar_load_error'),
		(e.SceneError = 'scene_error');
})(t || (t = {})),
	(function (e) {
		(e.AskForDefaults = 'ask_for_defaults'),
			(e.SDKHandshake = 'sdk_handshake'),
			(e.SDKHandshakeConfirmation = 'sdk_handshake_confirmation'),
			(e.CallbackEvent = 'callback_event'),
			(e.ReportError = 'report_error'),
			(e.GetAssetList = 'get_assets_list'),
			(e.GetActiveAssets = 'get_active_assets'),
			(e.SetAvailableAssets = 'set_assets_list'),
			(e.SetActiveAsset = 'set_active_asset'),
			(e.GetBodyList = 'get_bodies_list'),
			(e.GetActiveBody = 'get_avatar_info'),
			(e.SetAvailableBodies = 'set_bodies_list'),
			(e.SetActiveBody = 'set_active_body'),
			(e.GetAnimationList = 'get_animation_list'),
			(e.GetActiveAnimation = 'get_animation_info'),
			(e.SetActiveAnimation = 'set_active_animation'),
			(e.ExportAvatar = 'export_avatar'),
			(e.GenerateThumbnail = 'generate_thumbnail'),
			(e.SetParam = 'set_param'),
			(e.SetEyeColor = 'set_eye_color'),
			(e.SetHairColor = 'set_hair_color'),
			(e.SetEyewearColor = 'set_eyewear_color'),
			(e.SetBodyProportions = 'set_body_proportions'),
			(e.SetSkinTone = 'set_skin_tone'),
			(e.GetEyeColor = 'get_eye_color'),
			(e.GetHairColor = 'get_hair_color'),
			(e.GetEyewearColor = 'get_eyewear_color'),
			(e.GetBodyProportions = 'get_body_proportions'),
			(e.GetSkinTone = 'get_skin_tone'),
			(e.GetAvatarId = 'get_avatar_id');
	})(s || (s = {}));
var r = /*#__PURE__*/ (function () {
		function e() {
			this.listeners = {};
		}
		var t = e.prototype;
		return (
			(t.watch = function (e, t) {
				this.listeners[e] = t;
			}),
			(t.unwatch = function (e) {
				delete this.listeners[e];
			}),
			e
		);
	})(),
	n = /*#__PURE__*/ (function () {
		function e(e, t) {
			(this.handshakeData = {}),
				(this.recipient = void 0),
				(this.thisSourceName = 'v1.avaturn-sdk'),
				(this.expectedIncomingSourceName = 'v1.avaturn-sdk-server'),
				(this._queue = new r()),
				(this._messageHandler = this.messageHandler.bind(this)),
				e && (this.thisSourceName = e),
				t && (this.expectedIncomingSourceName = t);
		}
		var t = e.prototype;
		return (
			(t.sendMessage = function (e, t, s, r) {
				var n = this;
				return (
					void 0 === r && (r = !0),
					new Promise(function (o, i) {
						var a,
							c = Date.now(),
							u = s || e + c;
						r &&
							n._queue.watch(u, function (e, t) {
								var s = null != t ? t : null;
								e ? o(s) : i(s), n._queue.unwatch(u);
							}),
							null == (a = n.recipient) ||
								a.postMessage(
									{
										type: 'MESSAGE',
										source: n.thisSourceName,
										eventName: e,
										key: u,
										date: c,
										data: t,
										isOk: !0,
									},
									'*',
								),
							r || o(null);
					})
				);
			}),
			(t.messageHandler = function (e) {
				var t = e.data;
				this.expectedIncomingSourceName == t.source &&
					('RESPONSE' === t.type &&
						('sdk_handshake' === t.key &&
							this.sendMessage(
								s.SDKHandshakeConfirmation,
								this.handshakeData,
								void 0,
								!1,
							),
						this._queue.listeners[t.key] &&
							this._queue.listeners[t.key](t.isOk, t.data)),
					'MESSAGE' === t.type && this.handleMessage(t));
			}),
			(t.setupMessaging = function () {
				window.addEventListener('message', this._messageHandler);
			}),
			(t.destroyMessaging = function () {
				console.log('destroy'), window.removeEventListener('message', this._messageHandler);
			}),
			(t.sendResponse = function (e, t, s) {
				var r,
					n = void 0 === s ? { isOk: !0 } : s,
					o = n.isOk,
					i = n.data;
				if (this.recipient) {
					var a = {
						type: 'RESPONSE',
						source: this.thisSourceName,
						eventName: e,
						key: t,
						date: Date.now(),
						data: i,
						isOk: o,
					};
					null == (r = this.recipient) || r.postMessage(a, '*');
				} else console.log('Recipient is not set.');
			}),
			(t.handleMessage = function (e) {}),
			e
		);
	})(),
	o = /*#__PURE__*/ (function (t) {
		function r() {
			var e;
			return (
				((e = t.call(this) || this)._version = '1.1.4'),
				(e.defaultAssets = void 0),
				(e.sceneRef = null),
				(e.callbacks = {}),
				(e.suppressCallbacks = void 0),
				e
			);
		}
		var n, o;
		(o = t),
			((n = r).prototype = Object.create(o.prototype)),
			(n.prototype.constructor = n),
			e(n, o);
		var i = r.prototype;
		return (
			(i.applyStyles = function (e) {
				(e.style.width = '100%'), (e.style.height = '100%');
			}),
			(i.validateDefaultAssets = function (e) {
				return (
					'object' == typeof e &&
					'boolean' == typeof e.overrideSaved &&
					!!Array.isArray(e.assets)
				);
			}),
			(i.setupDOM = function (e, t, s) {
				var r,
					n = document.querySelector('#avaturn-sdk-iframe');
				n && n.remove();
				var o = document.createElement('iframe');
				o.setAttribute('src', t),
					o.setAttribute('id', 'avaturn-sdk-iframe'),
					o.setAttribute('allow', 'camera *; clipboard-write'),
					o.setAttribute('allowfullscreen', ''),
					o.setAttribute('frameborder', '0'),
					s ? o.setAttribute('class', s) : this.applyStyles(o),
					e.appendChild(o),
					(this.sceneRef = document.querySelector('#avaturn-sdk-iframe')),
					(this.recipient = null == (r = this.sceneRef) ? void 0 : r.contentWindow);
			}),
			(i.handleMessage = function (e) {
				var t, r, n, o;
				switch (e.eventName) {
					case s.AskForDefaults:
						this.sendResponse(s.AskForDefaults, e.key, {
							isOk: !0,
							data: this.defaultAssets,
						});
						break;
					case s.CallbackEvent:
						null == (t = (r = this.callbacks)[e.key]) || t.call(r, e.data);
						break;
					case s.ReportError:
						null == (n = (o = this.callbacks).error) || n.call(o, e.data);
				}
			}),
			(i.init = function (e, t) {
				var r = t.url,
					n = t.iframeClassName,
					o = t.disableUi,
					i = t.defaultAssets;
				try {
					var a = this;
					if (((a.suppressCallbacks = o), i && !a.validateDefaultAssets(i)))
						throw new Error("Field 'defaultAssets' has an invalid format");
					a.defaultAssets = i;
					var c = new URL(
						r ||
							'https://preview.avaturn.dev/editor?avatar_link=https%3A%2F%2Fassets.avaturn.me%2Feditor_resources%2Fdefault_male.glb',
					);
					return (
						c.searchParams.append('sdk', 'true'),
						o && c.searchParams.append('noui', 'true'),
						e ? a.setupDOM(e, c.toString(), n) : (a.recipient = window),
						(a.handshakeData = {
							url: document.location.href,
							environment: window.avaturnSDKEnvironment,
							version: a._version,
						}),
						a.setupMessaging(),
						Promise.resolve(
							a
								.sendMessage(s.SDKHandshake, a.handshakeData, 'sdk_handshake')
								.then(function () {
									try {
										return Promise.resolve(
											a.sendMessage(
												s.SDKHandshakeConfirmation,
												a.handshakeData,
												void 0,
												!1,
											),
										).then(function () {
											return a;
										});
									} catch (e) {
										return Promise.reject(e);
									}
								})
								.catch(function (e) {
									throw new Error(e);
								}),
						)
					);
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.destroy = function () {
				this.destroyMessaging(), (this.callbacks = {});
			}),
			(i.on = function (e, t) {
				return this.suppressCallbacks && 'load' != e
					? (console.log(
							"Can't use callbacks for " +
								e +
								' in disableUi mode. Use <action>.then(...) instead.',
						),
						this)
					: ((this.callbacks[e] = t), this);
			}),
			(i.getAssetList = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetAssetList));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setAvailableAssets = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetAvailableAssets, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getActiveAssets = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetActiveAssets));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setActiveAsset = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetActiveAsset, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setActiveBody = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetActiveBody, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getBodyList = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetBodyList));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getActiveBody = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetActiveBody));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setActiveAnimation = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetActiveAnimation, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getActiveAnimation = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetActiveAnimation));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getAnimationList = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetAnimationList));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.exportAvatar = function () {
				try {
					return Promise.resolve(
						this.sendMessage(s.ExportAvatar, void 0, 'export_avatar'),
					);
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setEyeColor = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetEyeColor, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setHairColor = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetHairColor, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setEyewearColor = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetEyewearColor, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setBodyProportions = function (e, t) {
				try {
					return Promise.resolve(
						this.sendMessage(s.SetBodyProportions, { key: e, value: t }),
					);
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.setSkinToneCorrection = function (e) {
				try {
					return Promise.resolve(this.sendMessage(s.SetSkinTone, e));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getEyeColor = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetEyeColor));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getHairColor = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetHairColor));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getEyewearColor = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetEyewearColor));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getBodyProportions = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetBodyProportions));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getSkinToneCorrection = function () {
				try {
					return Promise.resolve(this.sendMessage(s.GetSkinTone));
				} catch (e) {
					return Promise.reject(e);
				}
			}),
			(i.getAvatarId = function () {
				return this.sendMessage(s.GetAvatarId);
			}),
			r
		);
	})(n);
export { o as AvaturnSDK, s as MessageType, n as Messaging, t as SDKErrors };
