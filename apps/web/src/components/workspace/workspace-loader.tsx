import "./workspace-loader.css";

const contours = [
  "M263 369H365V431H424V491H483V551H541V605H564V705H541V763H498V801H429V732H379V670H321V551H263Z",
  "M992 369H890V431H830V491H771V551H713V605H690V705H713V763H756V801H825V732H875V670H934V551H992Z",
  "M554 419H593V458H554Z",
  "M661 419H700V458H661Z",
  "M583 467H671V554H583Z",
  "M580 571H674V705H580Z",
  "M580 721H674V825H661V886H593V825H580Z",
];

export function WorkspaceLoader() {
  return (
    <output className="workspace-loader" aria-label="Opening your workspace" aria-live="polite">
      <span className="sr-only">Opening your workspace…</span>
      <svg
        viewBox="223 329 809 597"
        fill="none"
        aria-hidden="true"
        className="workspace-loader-fly"
      >
        <g className="workspace-loader-surface">
          <g fill="#EBEBEB">
            <path d="M263 369H365V431H424V491H483V551H541V605H564V665H429V605H321V551H263Z" />
            <path d="M992 369H890V431H830V491H771V551H713V605H690V665H825V605H934V551H992Z" />
          </g>
          <g fill="#ADADAD">
            <path d="M321 605H429V665H564V705H541V763H498V801H429V732H379V670H321Z" />
            <path d="M934 605H825V665H690V705H713V763H756V801H825V732H875V670H934Z" />
          </g>
          <g fill="#BCBCBB">
            <path d="M554 419H593V458H554Z" />
            <path d="M661 419H700V458H661Z" />
            <path d="M583 467H671V554H583Z" />
          </g>
          <g fill="#959594">
            <path d="M580 571H674V705H580Z" />
            <path d="M580 721H674V825H661V886H593V825H580Z" />
          </g>
        </g>
        <g className="workspace-loader-traces">
          {contours.map((d, index) => (
            <path key={d} d={d} pathLength="100" style={{ animationDelay: `${index * -0.37}s` }} />
          ))}
        </g>
      </svg>
    </output>
  );
}
