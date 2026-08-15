/**
 * The studio's public embed contract.
 *
 * When the app runs inside an iframe (the Avatar Creator modal opened by
 * @three-ws/avatar), the export menu hands the finished avatar to the host
 * page instead of downloading it. Host side: avatar-sdk/src/creator.js.
 */

export const EXPORT_MESSAGE_SOURCE = 'characterstudio'

/** True when this window is embedded in a host page rather than top-level. */
export function isEmbedded() {
  return window.self !== window.top
}

/**
 * Build the export envelope the host SDK listens for.
 *
 * @param {ArrayBuffer} glb binary glTF of the finished avatar
 * @returns {{source: string, type: string, format: string, glb: ArrayBuffer}}
 */
export function buildExportMessage(glb) {
  return { source: EXPORT_MESSAGE_SOURCE, type: 'export', format: 'glb', glb }
}

/**
 * Post the finished avatar to the host window. The buffer is transferred, not
 * copied, so it is detached here and must not be reused by the caller.
 *
 * @param {ArrayBuffer} glb binary glTF of the finished avatar
 * @param {Window} targetWindow host window, defaults to the embedding parent
 * @returns {{source: string, type: string, format: string, glb: ArrayBuffer}} the posted message
 */
export function postAvatarToHost(glb, targetWindow = window.parent) {
  const message = buildExportMessage(glb)
  targetWindow.postMessage(message, '*', [glb])
  return message
}
