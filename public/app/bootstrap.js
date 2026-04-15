export function bootstrapAppShell({
  SEARCH_CONFIG_CLIPBOARD_KEY,
  swapRouteBtn,
  $,
  hideLocationMenu,
  setupInputEnforcement,
  setupLocationAutocomplete,
  setupPaxPopover,
  setupLayoverPopover,
  setupThemeToggle,
  setupTripTypeToggle,
  setupModeToggle,
  setupCalendarPopover,
  updatePaxLabel,
  updateModeFields,
  syncVisibleLocationMenus,
  syncPaxPopoverPosition,
  syncLayoverPopoverPosition,
  syncCalendarPopoverPosition,
  syncWorkspaceViewportHeight,
  syncSearchShellLayoutMetrics,
  syncSearchClipboardUI,
  beforeInitialRender,
  renderAll,
  settleInitialShellLayout,
  releaseInitialUiBootState,
}) {
  if (swapRouteBtn) {
    swapRouteBtn.addEventListener("click", () => {
      const originInput = $("origin");
      const destInput = $("destination");
      if (!originInput || !destInput) {
        return;
      }

      const tmpVal = originInput.value;
      const tmpCode = originInput.dataset.code;
      const tmpLabel = originInput.dataset.label;

      originInput.value = destInput.value;
      originInput.dataset.code = destInput.dataset.code || "";
      originInput.dataset.label = destInput.dataset.label || "";

      destInput.value = tmpVal;
      destInput.dataset.code = tmpCode || "";
      destInput.dataset.label = tmpLabel || "";

      hideLocationMenu("origin");
      hideLocationMenu("destination");
    });
  }

  setupInputEnforcement();
  setupLocationAutocomplete("origin");
  setupLocationAutocomplete("destination");
  setupPaxPopover();
  setupLayoverPopover();
  setupThemeToggle();
  setupTripTypeToggle();
  setupModeToggle();
  setupCalendarPopover();
  updatePaxLabel();
  updateModeFields();

  window.addEventListener("resize", () => {
    syncVisibleLocationMenus();
    syncPaxPopoverPosition();
    syncLayoverPopoverPosition();
    syncCalendarPopoverPosition();
    syncWorkspaceViewportHeight();
    syncSearchShellLayoutMetrics();
  });

  window.addEventListener("scroll", () => {
    syncVisibleLocationMenus();
    syncPaxPopoverPosition();
    syncLayoverPopoverPosition();
    syncCalendarPopoverPosition();
  }, true);

  window.addEventListener("storage", (event) => {
    if (event.key === SEARCH_CONFIG_CLIPBOARD_KEY) {
      syncSearchClipboardUI();
    }
  });

  const finalizeBoot = () => {
    syncSearchClipboardUI();
    renderAll();
    settleInitialShellLayout();
    releaseInitialUiBootState();
  };

  if (typeof beforeInitialRender === "function") {
    Promise.resolve(beforeInitialRender())
      .catch(() => undefined)
      .finally(finalizeBoot);
    return;
  }

  finalizeBoot();
}
