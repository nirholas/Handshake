import { useMemo, useState } from "react";
import { CheckIcon, CopyIcon, LockIcon, TocIcon } from "./icons";
import { RightRailPromos } from "./RightRailPromos";
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";

type McpDocumentationProps = {
  onInstallation: () => void;
  onPricing: () => void;
};

const MCP_TOC = [
  { id: "connect", label: "Connect" },
  { id: "authentication", label: "Authentication" },
  { id: "catalog", label: "Catalog access" },
  { id: "protocol", label: "Protocol" },
] as const;

const MCP_ACCESS = [
  ["Templates", "Complete landing pages and scene templates"],
  ["Components", "Every Community and Pro catalog component"],
  ["Prompts", "Item-specific implementation prompts"],
  ["Source", "Complete code, file manifests, assets, and usage"],
] as const;

const MCP_TOOLS = [
  ["search_catalog", "Find templates and components by name, category, runtime, or description."],
  ["get_catalog_item", "Read one item’s metadata, source manifest, assets, and usage."],
  ["get_item_source", "Retrieve the complete source bundle or one exact source file."],
  ["get_item_prompt", "Load the implementation prompt for a catalog item."],
] as const;

const DEFAULT_MCP_ENDPOINT = "https://threeui.com/api/mcp";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function McpDocumentation({ onInstallation, onPricing }: McpDocumentationProps) {
  const [toast, setToast] = useState("");
  const endpoint = import.meta.env.VITE_MCP_ENDPOINT?.trim() || DEFAULT_MCP_ENDPOINT;
  const clientConfig = useMemo(() => JSON.stringify({
    mcpServers: {
      threeui: {
        type: "http",
        url: endpoint,
      },
    },
  }, null, 2), [endpoint]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 1600);
  };

  const copyEndpoint = () => copyText(endpoint).then(() => notify("MCP URL copied"));

  return (
    <>
      <div className="pane-inner">
        <main className="doc mcp-doc" id="doc">
          <div className="crumb">Getting started</div>
          <div className="doc-topline">
            <h1>MCP</h1>
            <span className="pro-tag"><LockIcon />PRO</span>
          </div>
          <p className="lede">Bring the complete ThreeUI catalog into your AI coding client with authenticated, Pro-only access to templates, components, prompts, and source code.</p>
          <div className="tagrow">
            <span className="tag">Streamable HTTP</span>
            <span className="tag">OAuth 2.1</span>
            <span className="tag">2026-07-28</span>
          </div>
          <div className="divider" />

          <section id="connect">
            <h2>Connect ThreeUI</h2>
            <div className="mcp-connect card">
              <div className="mcp-connect-copy">
                <span className="pricing-plan-label">MCP endpoint</span>
                <strong>{endpoint}</strong>
                <p>Add this URL to any client that supports remote MCP servers. Your client opens a secure browser sign-in before it can discover or call the catalog.</p>
              </div>
              <button className="pricing-action pro-primary-action" onClick={copyEndpoint}><CopyIcon />Copy MCP URL</button>
            </div>
            <div className="code-card card mcp-config">
              <div className="tabbar">
                <div className="tabs"><span className="tab" aria-selected="true">Client config</span></div>
                <button className="icon-btn inset-shadow" aria-label="Copy MCP client configuration" onClick={() => copyText(clientConfig).then(() => notify("Configuration copied"))}>
                  <CopyIcon />
                </button>
              </div>
              <pre className="code"><SyntaxHighlightedCode code={clientConfig} language="javascript" /></pre>
            </div>
          </section>

          <section id="authentication">
            <h2>Authentication and Pro access</h2>
            <div className="mcp-auth-flow">
              <article className="card">
                <span>1</span>
                <div><strong>Connect</strong><p>Add the MCP URL in your coding client.</p></div>
              </article>
              <article className="card">
                <span>2</span>
                <div><strong>Sign in</strong><p>OAuth opens in your browser and returns a Supabase access token for the approved client.</p></div>
              </article>
              <article className="card">
                <span>3</span>
                <div><strong>Verify Pro</strong><p>The server checks both the required scopes and your current Pro entitlement.</p></div>
              </article>
            </div>
            <div className="integrity card mcp-security-note">
              <span className="integrity-icon"><LockIcon /></span>
              <div>
                <strong>Protected at the server</strong>
                <p>Anonymous, expired, non-OAuth, and non-Pro requests fail closed before catalog data is loaded. Tokens are accepted only in the Authorization header, checked against Supabase, and never stored by the MCP server.</p>
              </div>
            </div>
          </section>

          <section id="catalog">
            <h2>Everything in one catalog</h2>
            <div className="mcp-access-list card">
              {MCP_ACCESS.map(([name, description]) => (
                <div key={name}>
                  <CheckIcon />
                  <strong>{name}</strong>
                  <p>{description}</p>
                </div>
              ))}
            </div>

            <h2>Available tools</h2>
            <div className="table-wrap card">
              <table>
                <thead><tr><th>Tool</th><th>What it returns</th></tr></thead>
                <tbody>
                  {MCP_TOOLS.map(([name, description]) => (
                    <tr key={name}>
                      <td><span className="mono-chip">{name}</span></td>
                      <td>{description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="protocol">
            <h2>Built on the latest MCP specification</h2>
            <div className="mcp-protocol-grid">
              <article className="card"><strong>Stateless requests</strong><p>Every POST carries its protocol version and client capabilities. There are no server sessions to trust or restore.</p></article>
              <article className="card"><strong>Native primitives</strong><p>Catalog items are available through tools, resources, resource templates, and user-controlled prompts.</p></article>
              <article className="card"><strong>Protected resource discovery</strong><p>OAuth metadata tells clients where to authenticate and which minimum scopes to request.</p></article>
              <article className="card"><strong>Private responses</strong><p>Catalog and source results are marked private and are returned only after entitlement verification.</p></article>
            </div>
          </section>

          <nav className="pager" aria-label="MCP pagination">
            <button className="card" onClick={onInstallation}>
              <span className="k">Previous</span><span className="v">Installation</span>
            </button>
            <button className="card next" onClick={onPricing}>
              <span className="k">Need access?</span><span className="v">View Pro</span>
            </button>
          </nav>
        </main>

        <aside className="rail">
          <RightRailPromos onPricing={onPricing} />
          <div className="toc-head"><TocIcon />On this page</div>
          <nav className="toc" aria-label="On this page">
            {MCP_TOC.map((item, index) => (
              <div className={`toc-item${index === 0 ? " on" : ""}`} key={item.id}>
                <span className="rl" /><span className="dot" />
                <a href={`#${item.id}`}>{item.label}</a>
              </div>
            ))}
          </nav>
          <div className="actions">
            <button onClick={copyEndpoint}><CopyIcon />Copy MCP URL</button>
            <button onClick={onPricing}><LockIcon />View Pro access</button>
          </div>
        </aside>
      </div>
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
    </>
  );
}
