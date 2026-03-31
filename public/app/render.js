export function syncWorkspaceViewportHeight(workspace) {
  if (!workspace) {
    return;
  }

  const top = workspace.getBoundingClientRect().top;
  const available = Math.max(0, Math.floor(window.innerHeight - top));
  workspace.style.setProperty("--workspace-height", `${available}px`);
}

export function renderAll({
  state,
  renderToolbar,
  renderAirlineBar,
  renderResultsArea,
  renderDetailPanel,
  updateResultsToolbar,
  workspace,
}) {
  if (state.pollRenderHandle) {
    clearTimeout(state.pollRenderHandle);
    state.pollRenderHandle = null;
  }

  state.pollRenderPending = false;
  renderToolbar();
  renderAirlineBar();
  renderResultsArea();
  renderDetailPanel();
  updateResultsToolbar();
  syncWorkspaceViewportHeight(workspace);
}
