import CarPlay
import UIKit

/// three.ws Drive on the CarPlay screen.
///
/// This is a **voice-based conversational app**, the CarPlay category Apple
/// opened in iOS 26.4 for assistants like this one. What that category grants
/// is a template UI and an audio session; what it does not grant is a drawing
/// surface, so the agent's 3D face is not here. It is on the phone, in the
/// `/drive` page, which `DriveLink` drives. The car screen is the control
/// surface: what the agent is doing right now, and the few presses that beat
/// speaking.
///
/// The rules the category imposes, and how this file meets them:
///
///   - **Voice is the primary modality on launch.** Connecting activates the
///     Talk row's behaviour immediately: the page starts listening as soon as
///     the driver launches us from the CarPlay home screen.
///   - **No wake word.** Nothing here listens until a press or the driver's
///     hands-free choice says so.
///   - **An audio session only while voice is in use.** `DriveLink` opens and
///     closes it from the page's own state, not for the length of the trip.
///   - **Template depth of three.** This uses one: a root list, with the voice
///     template presented over it during a turn.
///
/// Requires the `com.apple.developer.carplay-voice-based-conversation`
/// entitlement (App.entitlements), which Apple grants per app on request.
/// Without it the scene never connects and the rest of the app is unaffected.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

    private var interfaceController: CPInterfaceController?
    private var voiceTemplatePresented = false

    // Identifiers for the voice template's states, kept in one place because
    // activating an identifier the template does not carry is a silent no-op.
    private enum VoiceState: String {
        case listening
        case working
        case speaking
    }

    // MARK: - Scene lifecycle

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController

        DriveLink.shared.onChange = { [weak self] in
            DispatchQueue.main.async { self?.render() }
        }
        DriveLink.shared.openDriveSurface()

        interfaceController.setRootTemplate(makeRootTemplate(), animated: false, completion: nil)
        // Voice first: the driver launched an assistant, so it starts listening
        // rather than waiting to be told twice.
        DriveLink.shared.send("talk-start")
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        DriveLink.shared.send("talk-stop")
        DriveLink.shared.onChange = nil
        DriveLink.shared.closeDriveSurface()
        DriveLink.shared.reset()
        self.interfaceController = nil
        voiceTemplatePresented = false
    }

    // MARK: - Root list

    /// The four controls, in the order a driver reaches for them. They mirror
    /// the deck on the `/drive` page exactly, so the car screen and the phone
    /// never disagree about what is available.
    private func makeRootTemplate() -> CPListTemplate {
        let template = CPListTemplate(title: "three.ws Drive", sections: [makeSection()])
        template.emptyViewTitleVariants = ["three.ws Drive"]
        template.emptyViewSubtitleVariants = ["Say what you need. Your agent is listening."]
        return template
    }

    private func makeSection() -> CPListSection {
        let link = DriveLink.shared
        let fallback: [DriveLink.Action] = [
            .init(id: "talk", label: "Talk", enabled: true),
            .init(id: "hands", label: "Hands free", enabled: true),
            .init(id: "repeat", label: "Repeat", enabled: false),
            .init(id: "hush", label: "Quiet", enabled: false),
        ]
        // Until the page has published its first action set, show the same four
        // in their resting state rather than an empty screen.
        let actions = link.actions.isEmpty ? fallback : link.actions

        let items: [CPListItem] = actions.map { action in
            let item = CPListItem(text: action.label, detailText: detail(for: action))
            item.isEnabled = action.enabled
            item.handler = { [weak self] _, completion in
                self?.perform(action.id)
                completion()
            }
            return item
        }
        return CPListSection(items: items, header: link.agentName, sectionIndexTitle: nil)
    }

    /// One short line of context per row. A driver reads at most this much.
    private func detail(for action: DriveLink.Action) -> String? {
        let link = DriveLink.shared
        switch action.id {
        case "talk":
            return link.state == .listening ? "Listening" : "Ask your agent something"
        case "hands":
            return "Keep the mic open between turns"
        case "repeat":
            return link.lastSpoken
        case "hush":
            return link.state == .speaking ? "Stop talking" : nil
        default:
            return nil
        }
    }

    private func perform(_ id: String) {
        switch id {
        case "talk":
            DriveLink.shared.send(DriveLink.shared.state == .listening ? "talk-stop" : "talk-start")
        case "hands":
            DriveLink.shared.send("hands")
        case "repeat":
            DriveLink.shared.send("repeat")
        case "hush":
            DriveLink.shared.send("hush")
        default:
            break
        }
    }

    // MARK: - Voice template

    /// Presented for the length of a turn and dismissed the moment it ends,
    /// which is the contract CarPlay places on this template: it exists while
    /// audio input is in use, not as a screen the driver sits on.
    private func makeVoiceTemplate() -> CPVoiceControlTemplate {
        CPVoiceControlTemplate(voiceControlStates: [
            CPVoiceControlState(
                identifier: VoiceState.listening.rawValue,
                titleVariants: ["Listening", "Go ahead"],
                image: nil,
                repeats: true
            ),
            CPVoiceControlState(
                identifier: VoiceState.working.rawValue,
                titleVariants: ["Thinking", "One moment"],
                image: nil,
                repeats: true
            ),
            CPVoiceControlState(
                identifier: VoiceState.speaking.rawValue,
                titleVariants: ["Speaking"],
                image: nil,
                repeats: false
            ),
        ])
    }

    private func voiceState(for state: DriveLink.State) -> VoiceState? {
        switch state {
        case .listening: return .listening
        case .transcribing, .thinking: return .working
        case .speaking: return .speaking
        case .idle: return nil
        }
    }

    // MARK: - Rendering

    private func render() {
        guard let interfaceController else { return }

        if let root = interfaceController.rootTemplate as? CPListTemplate {
            root.updateSections([makeSection()])
        }

        let link = DriveLink.shared
        guard let target = voiceState(for: link.state) else {
            if voiceTemplatePresented {
                voiceTemplatePresented = false
                interfaceController.dismissTemplate(animated: true, completion: nil)
            }
            return
        }

        if voiceTemplatePresented {
            (interfaceController.presentedTemplate as? CPVoiceControlTemplate)?
                .activateVoiceControlState(withIdentifier: target.rawValue)
            return
        }

        voiceTemplatePresented = true
        let template = makeVoiceTemplate()
        interfaceController.presentTemplate(template, animated: true) { presented, _ in
            guard presented else {
                self.voiceTemplatePresented = false
                return
            }
            template.activateVoiceControlState(withIdentifier: target.rawValue)
        }
    }
}
