import { useState } from "react";
import type { ReadyShader } from "../data/shaders";
import { CopyIcon, TocIcon } from "./icons";
import { INSTALL_COMMANDS, InstallationSteps } from "./InstallationSteps";
import { RightRailPromos } from "./RightRailPromos";
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";

type InstallationDocumentationProps = {
  onPricing: () => void;
  onSelect: (id: ReadyShader["id"]) => void;
};

const REQUIREMENTS = [
  { name: "react", type: "peer", value: ">= 18.2.0" },
  { name: "react-dom", type: "peer", value: ">= 18.2.0" },
  { name: "Node.js", type: "Pro CLI", value: ">= 20" },
  { name: "WebGL", type: "browser", value: "WebGL or WebGL2" },
] as const;

const INSTALLATION_TOC = [
  { id: "package", label: "Install package" },
  { id: "requirements", label: "Requirements" },
  { id: "pro", label: "Pro source" },
  { id: "verify", label: "Verify setup" },
] as const;

const PRO_INSTALL_COMMAND = "npx @designcodeio/threeui-cli add cross-beam";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function InstallationDocumentation({ onPricing, onSelect }: InstallationDocumentationProps) {
  const [toast, setToast] = useState("");

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1600);
  };

  return (
    <>
      <div className="pane-inner">
        <main className="doc" id="doc">
          <div className="crumb">Getting started</div>
          <h1>Installation</h1>
          <p className="lede">Install Community components from npm, or authenticate to download entitled Pro source into your project.</p>
          <div className="tagrow">
            <span className="tag">@designcodeio/threeui</span>
          </div>
          <div className="divider" />

          <h2 id="package">Install the package</h2>
          <InstallationSteps importName="PredictiveArcCanvas" includeStyles onNotify={notify} />

          <h2 id="requirements">Requirements</h2>
          <div className="table-wrap card">
            <table>
              <thead><tr><th>Dependency</th><th>Type</th><th className="col-default">Version</th></tr></thead>
              <tbody>
                {REQUIREMENTS.map((row) => (
                  <tr key={row.name}>
                    <td><span className="mono-chip">{row.name}</span></td>
                    <td><span className="mono-chip">{row.type}</span></td>
                    <td className="col-default">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 id="pro">Install Pro source</h2>
          <p>Pro implementation source is not published to npm. Active members use the public CLI, sign in through OAuth in the browser, and receive source only after the server verifies their current entitlement.</p>
          <div className="code-card padded card code-inline">
            <button
              className="icon-btn inset-shadow copy-corner"
              aria-label="Copy Pro component command"
              onClick={() => copyText(PRO_INSTALL_COMMAND).then(() => notify("Copied"))}
            >
              <CopyIcon />
            </button>
            <pre className="code"><SyntaxHighlightedCode code={PRO_INSTALL_COMMAND} language="text" /></pre>
          </div>
          <div className="integrity card">
            <span className="integrity-icon"><span className="status-dot" /></span>
            <div>
              <strong>OAuth + server-side entitlement</strong>
              <p>The CLI stores a refreshable session with owner-only permissions. Pro files never enter the public React or CLI packages, and changed project files are not overwritten unless you pass <span className="mono-chip">--force</span>.</p>
            </div>
          </div>

          <h2 id="verify">Verify setup</h2>
          <div className="integrity card">
            <span className="integrity-icon"><span className="status-dot" /></span>
            <div>
              <strong>Choose a ready renderer</strong>
              <p>Every shader page includes a live preview, exact import name, runtime contract, and its first-party source record.</p>
            </div>
          </div>

          <nav className="pager" aria-label="Installation pagination">
            <span />
            <button className="card next" onClick={() => onSelect("predictive-arc")}>
              <span className="k">Next</span><span className="v">Predictive Arc</span>
            </button>
          </nav>
        </main>

        <aside className="rail">
          <RightRailPromos onPricing={onPricing} />
          <div className="toc-head"><TocIcon />On this page</div>
          <nav className="toc" aria-label="On this page">
            {INSTALLATION_TOC.map((item, index) => (
              <div className={`toc-item${index === 0 ? " on" : ""}`} key={item.id}>
                <span className="rl" /><span className="dot" />
                <a href={`#${item.id}`}>{item.label}</a>
              </div>
            ))}
          </nav>
          <div className="actions">
            <button onClick={() => copyText(INSTALL_COMMANDS.npm).then(() => notify("Copied"))}>
              <CopyIcon />Copy install command
            </button>
            <button onClick={() => onSelect("predictive-arc")}>
              <span className="action-check">→</span>Browse shaders
            </button>
          </div>
        </aside>
      </div>
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
    </>
  );
}
