/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Ci } = require("chrome");
const Services = require("Services");
const EventEmitter = require("devtools/shared/event-emitter");
const {
  getOrientation,
} = require("devtools/client/responsive/utils/orientation");
const Constants = require("devtools/client/responsive/constants");
const { TargetList } = require("devtools/shared/resources/target-list");

loader.lazyRequireGetter(
  this,
  "DebuggerClient",
  "devtools/shared/client/debugger-client",
  true
);
loader.lazyRequireGetter(
  this,
  "DebuggerServer",
  "devtools/server/debugger-server",
  true
);
loader.lazyRequireGetter(
  this,
  "throttlingProfiles",
  "devtools/client/shared/components/throttling/profiles"
);
loader.lazyRequireGetter(
  this,
  "swapToInnerBrowser",
  "devtools/client/responsive/browser/swap",
  true
);
loader.lazyRequireGetter(
  this,
  "message",
  "devtools/client/responsive/utils/message"
);
loader.lazyRequireGetter(
  this,
  "showNotification",
  "devtools/client/responsive/utils/notification",
  true
);
loader.lazyRequireGetter(this, "l10n", "devtools/client/responsive/utils/l10n");
loader.lazyRequireGetter(this, "asyncStorage", "devtools/shared/async-storage");
loader.lazyRequireGetter(
  this,
  "saveScreenshot",
  "devtools/shared/screenshot/save"
);

const TOOL_URL = "chrome://devtools/content/responsive/index.xhtml";

const RELOAD_CONDITION_PREF_PREFIX = "devtools.responsive.reloadConditions.";
const RELOAD_NOTIFICATION_PREF =
  "devtools.responsive.reloadNotification.enabled";

function debug(msg) {
  // console.log(`RDM manager: ${msg}`);
}

/**
 * ResponsiveUI manages the responsive design tool for a specific tab.  The
 * actual tool itself lives in a separate chrome:// document that is loaded into
 * the tab upon opening responsive design.  This object acts a helper to
 * integrate the tool into the surrounding browser UI as needed.
 */
class ResponsiveUI {
  /**
   * @param {ResponsiveUIManager} manager
   *        The ResponsiveUIManager instance.
   * @param {ChromeWindow} window
   *        The main browser chrome window (that holds many tabs).
   * @param {Tab} tab
   *        The specific browser <tab> element this responsive instance is for.
   */
  constructor(manager, window, tab) {
    this.manager = manager;
    // The main browser chrome window (that holds many tabs).
    this.browserWindow = window;
    // The specific browser tab this responsive instance is for.
    this.tab = tab;

    // Flag set when destruction has begun.
    this.destroying = false;
    // Flag set when destruction has ended.
    this.destroyed = false;
    /**
     * A window reference for the chrome:// document that displays the responsive
     * design tool.  It is safe to reference this window directly even with e10s,
     * as the tool UI is always loaded in the parent process.  The web content
     * contained *within* the tool UI on the other hand is loaded in the child
     * process.
     *
     * TODO: we should remove this as part of Bug 1585096
     */
    this.toolWindow = null;
    // The iframe containing the RDM UI.
    this.rdmFrame = null;

    // Bind callbacks for resizers.
    this.onResizeDrag = this.onResizeDrag.bind(this);
    this.onResizeStart = this.onResizeStart.bind(this);
    this.onResizeStop = this.onResizeStop.bind(this);

    this.onTargetAvailable = this.onTargetAvailable.bind(this);

    // Promise resovled when the UI init has completed.
    this.inited = this.init();

    EventEmitter.decorate(this);
  }

  get docShell() {
    return this.isBrowserUIEnabled
      ? this.rdmFrame.contentWindow.docShell
      : this.toolWindow.docShell;
  }

  get isBrowserUIEnabled() {
    if (!this._isBrowserUIEnabled) {
      this._isBrowserUIEnabled = Services.prefs.getBoolPref(
        "devtools.responsive.browserUI.enabled"
      );
    }

    return this._isBrowserUIEnabled;
  }

  get currentTarget() {
    return this.targetList.targetFront;
  }

  /**
   * Open RDM while preserving the state of the page.  We use `swapFrameLoaders`
   * to ensure all in-page state is preserved, just like when you move a tab to
   * a new window.
   *
   * For more details, see /devtools/docs/responsive-design-mode.md.
   */
  async init() {
    debug("Init start");

    const ui = this;

    if (this.isBrowserUIEnabled) {
      this.initRDMFrame();
    }

    // Watch for tab close and window close so we can clean up RDM synchronously
    this.tab.addEventListener("TabClose", this);
    this.browserWindow.addEventListener("unload", this);

    if (!this.isBrowserUIEnabled) {
      // Swap page content from the current tab into a viewport within RDM
      debug("Create browser swapper");
      this.swap = swapToInnerBrowser({
        tab: this.tab,
        containerURL: TOOL_URL,
        async getInnerBrowser(containerBrowser) {
          const toolWindow = (ui.toolWindow = containerBrowser.contentWindow);
          toolWindow.addEventListener("message", ui);
          debug("Wait until init from inner");
          await message.request(toolWindow, "init");
          toolWindow.addInitialViewport({
            uri: "about:blank",
            userContextId: ui.tab.userContextId,
          });
          debug("Wait until browser mounted");
          await message.wait(toolWindow, "browser-mounted");
          return ui.getViewportBrowser();
        },
      });
      debug("Wait until swap start");
      await this.swap.start();
    } else {
      this.rdmFrame.contentWindow.addEventListener("message", this);
    }

    // Set the ui toolWindow to fullZoom and textZoom of 100%. Directly change
    // the zoom levels of the toolwindow docshell. That doesn't affect the zoom
    // of the RDM content, but it does send events that confuse the Zoom UI.
    // So before we adjust the zoom levels of the toolWindow, we first cache
    // the reported zoom levels of the RDM content, because we'll have to
    // re-apply them to re-sync the Zoom UI.

    // Cache the values now and we'll re-apply them near the end of this function.
    // This is important since other steps here can also cause the Zoom UI update
    // event to be sent for other browsers, and this means that the changes from
    // our Zoom UI update event would be overwritten. After this function, future
    // changes to zoom levels will send Zoom UI update events in an order that
    // keeps the Zoom UI synchronized with the RDM content zoom levels.
    const rdmContent = this.tab.linkedBrowser;
    const fullZoom = rdmContent.fullZoom;
    const textZoom = rdmContent.textZoom;

    // Listen to FullZoomChange events coming from the browser window,
    // so that we can zoom the size of the viewport by the same amount.
    if (this.isBrowserUIEnabled) {
      this.browserWindow.addEventListener("FullZoomChange", this);
    } else {
      this.docShell.contentViewer.fullZoom = 1;
      this.docShell.contentViewer.textZoom = 1;

      this.tab.linkedBrowser.addEventListener("FullZoomChange", this);
    }

    this.tab.addEventListener("BeforeTabRemotenessChange", this);

    if (!this.isBrowserUIEnabled) {
      // Notify the inner browser to start the frame script
      debug("Wait until start frame script");
      await message.request(this.toolWindow, "start-frame-script");
    }

    // Get the protocol ready to speak with responsive emulation actor
    debug("Wait until RDP server connect");
    await this.connectToServer();

    // Restore the previous UI state.
    await this.restoreUIState();

    if (!this.isBrowserUIEnabled) {
      // Force the newly created Zoom actor to cache its 1.0 zoom level. This
      // prevents it from sending out FullZoomChange events when the content
      // full zoom level is changed the first time.
      const bc = this.toolWindow.docShell.browsingContext;
      const zoomActor = bc.currentWindowGlobal.getActor("Zoom");
      zoomActor.sendAsyncMessage("FullZoom", { value: 1.0 });

      // Re-apply our cached zoom levels. Other Zoom UI update events have finished
      // by now.
      rdmContent.fullZoom = fullZoom;
      rdmContent.textZoom = textZoom;
    }

    // Non-blocking message to tool UI to start any delayed init activities
    if (!this.isBrowserUIEnabled) {
      message.post(this.toolWindow, "post-init");
    } else {
      message.post(this.rdmFrame.contentWindow, "post-init");
    }

    debug("Init done");
  }

  /**
   * Initialize the RDM iframe inside of the browser document.
   */
  initRDMFrame() {
    const { document: doc, gBrowser } = this.browserWindow;
    const rdmFrame = doc.createElement("iframe");
    rdmFrame.src = "chrome://devtools/content/responsive/toolbar.xhtml";
    rdmFrame.classList.add("rdm-toolbar");

    // Create resizer handlers
    const resizeHandle = doc.createElement("div");
    resizeHandle.classList.add("viewport-resize-handle");
    const resizeHandleX = doc.createElement("div");
    resizeHandleX.classList.add("viewport-horizontal-resize-handle");
    const resizeHandleY = doc.createElement("div");
    resizeHandleY.classList.add("viewport-vertical-resize-handle");

    this.browserContainerEl = gBrowser.getBrowserContainer(
      gBrowser.getBrowserForTab(this.tab)
    );
    this.browserStackEl = this.browserContainerEl.querySelector(
      ".browserStack"
    );

    this.browserContainerEl.classList.add("responsive-mode");

    // Prepend the RDM iframe inside of the current tab's browser stack.
    this.browserStackEl.prepend(rdmFrame);
    this.browserStackEl.append(resizeHandle);
    this.browserStackEl.append(resizeHandleX);
    this.browserStackEl.append(resizeHandleY);

    // Wait for the frame script to be loaded.
    message.wait(rdmFrame.contentWindow, "script-init").then(async () => {
      // Notify the frame window that the Resposnive UI manager has begun initializing.
      // At this point, we can render our React content inside the frame.
      message.post(rdmFrame.contentWindow, "init");
      // Wait for the tools to be rendered above the content. The frame script will
      // then dispatch the necessary actions to the Redux store to give the toolbar the
      // state it needs.
      message.wait(rdmFrame.contentWindow, "init:done").then(() => {
        rdmFrame.contentWindow.addInitialViewport({
          userContextId: this.tab.userContextId,
        });
      });
    });

    this.rdmFrame = rdmFrame;

    this.resizeHandle = resizeHandle;
    this.resizeHandle.addEventListener("mousedown", this.onResizeStart);

    this.resizeHandleX = resizeHandleX;
    this.resizeHandleX.addEventListener("mousedown", this.onResizeStart);

    this.resizeHandleY = resizeHandleY;
    this.resizeHandleY.addEventListener("mousedown", this.onResizeStart);
  }

  /**
   * Close RDM and restore page content back into a regular tab.
   *
   * @param object
   *        Destroy options, which currently includes a `reason` string.
   * @return boolean
   *         Whether this call is actually destroying.  False means destruction
   *         was already in progress.
   */
  async destroy(options) {
    if (this.destroying) {
      return false;
    }
    this.destroying = true;

    this.targetList.unwatchTargets(
      [this.targetList.TYPES.FRAME],
      this.onTargetAvailable
    );

    // If our tab is about to be closed, there's not enough time to exit
    // gracefully, but that shouldn't be a problem since the tab will go away.
    // So, skip any waiting when we're about to close the tab.
    const isTabDestroyed = !this.tab.linkedBrowser;
    const isWindowClosing =
      (options && options.reason === "unload") || isTabDestroyed;
    const isTabContentDestroying =
      isWindowClosing ||
      (options &&
        (options.reason === "TabClose" ||
          options.reason === "BeforeTabRemotenessChange"));

    // Ensure init has finished before starting destroy
    if (!isTabContentDestroying) {
      await this.inited;

      // Restore screen orientation of physical device.
      await this.updateScreenOrientation("landscape-primary", 0);
    }

    if (this.isBrowserUIEnabled) {
      await this.responsiveFront.setDocumentInRDMPane(false);
    }

    this.tab.removeEventListener("TabClose", this);
    this.tab.removeEventListener("BeforeTabRemotenessChange", this);
    this.browserWindow.removeEventListener("unload", this);

    if (!this.isBrowserUIEnabled) {
      this.tab.linkedBrowser.removeEventListener("FullZoomChange", this);
      this.toolWindow.removeEventListener("message", this);
    } else {
      this.browserWindow.removeEventListener("FullZoomChange", this);
      this.rdmFrame.contentWindow.removeEventListener("message", this);
      this.rdmFrame.remove();

      // Clean up resize handlers
      this.resizeHandle.remove();
      this.resizeHandleX.remove();
      this.resizeHandleY.remove();

      this.browserContainerEl.classList.remove("responsive-mode");
      this.browserStackEl.style.removeProperty("--rdm-width");
      this.browserStackEl.style.removeProperty("--rdm-height");
    }

    if (!this.isBrowserUIEnabled && !isTabContentDestroying) {
      // Notify the inner browser to stop the frame script
      await message.request(this.toolWindow, "stop-frame-script");
    }

    // Ensure the tab is reloaded if required when exiting RDM so that no emulated
    // settings are left in a customized state.
    if (!isTabContentDestroying) {
      let reloadNeeded = false;
      await this.updateDPPX();
      await this.updateNetworkThrottling();
      reloadNeeded |=
        (await this.updateUserAgent()) && this.reloadOnChange("userAgent");
      reloadNeeded |=
        (await this.updateTouchSimulation()) &&
        this.reloadOnChange("touchSimulation");
      if (reloadNeeded) {
        this.getViewportBrowser().reload();
      }
    }

    // Destroy local state
    const swap = this.swap;
    this.browserContainerEl = null;
    this.browserStackEl = null;
    this.browserWindow = null;
    this.tab = null;
    this.inited = null;
    this.rdmFrame = null;
    this.resizeHandle = null;
    this.resizeHandleX = null;
    this.resizeHandleY = null;
    this.toolWindow = null;
    this.swap = null;

    // Close the debugger client used to speak with responsive emulation actor.
    // The actor handles clearing any overrides itself, so it's not necessary to clear
    // anything on shutdown client side.
    const clientClosed = this.client.close();
    if (!isTabContentDestroying) {
      await clientClosed;
    }
    this.client = this.responsiveFront = null;

    if (!this.isBrowserUIEnabled && !isWindowClosing) {
      // Undo the swap and return the content back to a normal tab
      swap.stop();
    }

    this.destroyed = true;

    return true;
  }

  async connectToServer() {
    // The client being instantiated here is separate from the toolbox. It is being used
    // separately and has a life cycle that doesn't correspond to the toolbox.
    DebuggerServer.init();
    DebuggerServer.registerAllActors();
    this.client = new DebuggerClient(DebuggerServer.connectPipe());
    await this.client.connect();

    const targetFront = await this.client.mainRoot.getTab();
    this.targetList = new TargetList(this.client.mainRoot, targetFront);
    await this.targetList.watchTargets(
      [this.targetList.TYPES.FRAME],
      this.onTargetAvailable
    );
  }

  /**
   * Show one-time notification about reloads for responsive emulation.
   */
  showReloadNotification() {
    if (Services.prefs.getBoolPref(RELOAD_NOTIFICATION_PREF, false)) {
      showNotification(this.browserWindow, this.tab, {
        msg: l10n.getFormatStr("responsive.reloadNotification.description2"),
      });
      Services.prefs.setBoolPref(RELOAD_NOTIFICATION_PREF, false);
    }
  }

  reloadOnChange(id) {
    this.showReloadNotification();
    const pref = RELOAD_CONDITION_PREF_PREFIX + id;
    return Services.prefs.getBoolPref(pref, false);
  }

  handleEvent(event) {
    const { browserWindow, tab, toolWindow } = this;

    switch (event.type) {
      case "message":
        this.handleMessage(event);
        break;
      case "FullZoomChange":
        if (this.isBrowserUIEnabled) {
          // Get the current device size and update to that size, which
          // will pick up changes to the zoom.
          const {
            width,
            height,
          } = this.rdmFrame.contentWindow.getViewportSize();
          this.updateViewportSize(width, height);
        } else {
          const zoom = tab.linkedBrowser.fullZoom;
          toolWindow.setViewportZoom(zoom);
        }
        break;
      case "BeforeTabRemotenessChange":
        this.onRemotenessChange(event);
        break;
      case "TabClose":
      case "unload":
        this.manager.closeIfNeeded(browserWindow, tab, {
          reason: event.type,
        });
        break;
    }
  }

  handleMessage(event) {
    if (event.origin !== "chrome://devtools") {
      return;
    }

    switch (event.data.type) {
      case "change-device":
        this.onChangeDevice(event);
        break;
      case "change-network-throttling":
        this.onChangeNetworkThrottling(event);
        break;
      case "change-pixel-ratio":
        this.onChangePixelRatio(event);
        break;
      case "change-touch-simulation":
        this.onChangeTouchSimulation(event);
        break;
      case "change-user-agent":
        this.onChangeUserAgent(event);
        break;
      case "content-resize":
        this.onContentResize(event);
        break;
      case "exit":
        this.onExit();
        break;
      case "remove-device-association":
        this.onRemoveDeviceAssociation();
        break;
      case "viewport-orientation-change":
        this.onRotateViewport(event);
        break;
      case "viewport-resize":
        this.onResizeViewport(event);
        break;
      case "screenshot":
        this.onScreenshot();
        break;
      case "toggle-left-alignment":
        this.onToggleLeftAlignment(event);
        break;
      case "update-device-modal":
        this.onUpdateDeviceModal(event);
    }
  }

  async onChangeDevice(event) {
    const { pixelRatio, touch, userAgent } = event.data.device;
    let reloadNeeded = false;
    await this.updateDPPX(pixelRatio);

    // Get the orientation values of the device we are changing to and update.
    const { device, viewport } = event.data;
    const { type, angle } = getOrientation(device, viewport);
    await this.updateScreenOrientation(type, angle);

    reloadNeeded |=
      (await this.updateUserAgent(userAgent)) &&
      this.reloadOnChange("userAgent");
    reloadNeeded |=
      (await this.updateTouchSimulation(touch)) &&
      this.reloadOnChange("touchSimulation");
    if (reloadNeeded) {
      this.getViewportBrowser().reload();
    }
    // Used by tests
    this.emit("device-changed");
  }

  async onChangeNetworkThrottling(event) {
    const { enabled, profile } = event.data;
    await this.updateNetworkThrottling(enabled, profile);
    // Used by tests
    this.emit("network-throttling-changed");
  }

  onChangePixelRatio(event) {
    const { pixelRatio } = event.data;
    this.updateDPPX(pixelRatio);
  }

  async onChangeTouchSimulation(event) {
    const { enabled } = event.data;
    const reloadNeeded =
      (await this.updateTouchSimulation(enabled)) &&
      this.reloadOnChange("touchSimulation");
    if (reloadNeeded) {
      this.getViewportBrowser().reload();
    }
    // Used by tests
    this.emit("touch-simulation-changed");
  }

  async onChangeUserAgent(event) {
    const { userAgent } = event.data;
    const reloadNeeded =
      (await this.updateUserAgent(userAgent)) &&
      this.reloadOnChange("userAgent");
    if (reloadNeeded) {
      this.getViewportBrowser().reload();
    }
    this.emit("user-agent-changed");
  }

  onContentResize(event) {
    const { width, height } = event.data;
    this.emit("content-resize", {
      width,
      height,
    });
  }

  onExit() {
    const { browserWindow, tab } = this;
    this.manager.closeIfNeeded(browserWindow, tab);
  }

  async onRemoveDeviceAssociation() {
    let reloadNeeded = false;
    await this.updateDPPX();
    reloadNeeded |=
      (await this.updateUserAgent()) && this.reloadOnChange("userAgent");
    reloadNeeded |=
      (await this.updateTouchSimulation()) &&
      this.reloadOnChange("touchSimulation");
    if (reloadNeeded) {
      this.getViewportBrowser().reload();
    }
    // Used by tests
    this.emit("device-association-removed");
  }

  /**
   * Resizing the browser on mousemove
   */
  onResizeDrag({ screenX, screenY }) {
    if (!this.isResizing || !this.rdmFrame.contentWindow) {
      return;
    }

    const zoom = this.tab.linkedBrowser.fullZoom;

    let deltaX = (screenX - this.lastScreenX) / zoom;
    let deltaY = (screenY - this.lastScreenY) / zoom;

    const leftAlignmentEnabled = Services.prefs.getBoolPref(
      "devtools.responsive.leftAlignViewport.enabled",
      false
    );

    if (!leftAlignmentEnabled) {
      // The viewport is centered horizontally, so horizontal resize resizes
      // by twice the distance the mouse was dragged - on left and right side.
      deltaX = deltaX * 2;
    }

    if (this.ignoreX) {
      deltaX = 0;
    }
    if (this.ignoreY) {
      deltaY = 0;
    }

    const viewportSize = this.rdmFrame.contentWindow.getViewportSize();

    let width = Math.round(viewportSize.width + deltaX);
    let height = Math.round(viewportSize.height + deltaY);

    if (width < Constants.MIN_VIEWPORT_DIMENSION) {
      width = Constants.MIN_VIEWPORT_DIMENSION;
    } else if (width != viewportSize.width) {
      this.lastScreenX = screenX;
    }

    if (height < Constants.MIN_VIEWPORT_DIMENSION) {
      height = Constants.MIN_VIEWPORT_DIMENSION;
    } else if (height != viewportSize.height) {
      this.lastScreenY = screenY;
    }

    // Update the RDM store and viewport size with the new width and height.
    this.rdmFrame.contentWindow.setViewportSize({ width, height });
    this.updateViewportSize(width, height);

    // Change the device selector back to an unselected device
    if (this.rdmFrame.contentWindow.getAssociatedDevice()) {
      this.rdmFrame.contentWindow.clearDeviceAssociation();
    }
  }

  /**
   * Start the process of resizing the browser.
   */
  onResizeStart({ target, screenX, screenY }) {
    this.browserWindow.addEventListener("mousemove", this.onResizeDrag, true);
    this.browserWindow.addEventListener("mouseup", this.onResizeStop, true);

    this.isResizing = true;
    this.lastScreenX = screenX;
    this.lastScreenY = screenY;
    this.ignoreX = target === this.resizeHandleY;
    this.ignoreY = target === this.resizeHandleX;
  }

  /**
   * Stop the process of resizing the browser.
   */
  onResizeStop() {
    this.browserWindow.removeEventListener(
      "mousemove",
      this.onResizeDrag,
      true
    );
    this.browserWindow.removeEventListener("mouseup", this.onResizeStop, true);

    this.isResizing = false;
    this.lastScreenX = 0;
    this.lastScreenY = 0;
    this.ignoreX = false;
    this.ignoreY = false;
  }

  onResizeViewport(event) {
    const { width, height } = event.data;
    this.updateViewportSize(width, height);
    this.emit("viewport-resize", {
      width,
      height,
    });
  }

  async onRotateViewport(event) {
    const { orientationType: type, angle, isViewportRotated } = event.data;
    await this.updateScreenOrientation(type, angle, isViewportRotated);
  }

  async onScreenshot() {
    const captureScreenshotSupported = await this.currentTarget.actorHasMethod(
      "responsive",
      "captureScreenshot"
    );

    if (captureScreenshotSupported) {
      const data = await this.responsiveFront.captureScreenshot();
      await saveScreenshot(this.browserWindow, {}, data);

      message.post(this.rdmFrame.contentWindow, "screenshot-captured");
    }
  }

  onToggleLeftAlignment(event) {
    this.updateUIAlignment(event.data.leftAlignmentEnabled);
  }

  onUpdateDeviceModal(event) {
    this.browserStackEl.classList.toggle(
      "device-modal-opened",
      event.data.isOpen
    );
  }

  async hasDeviceState() {
    const deviceState = await asyncStorage.getItem(
      "devtools.responsive.deviceState"
    );
    return !!deviceState;
  }

  /**
   * Restores the previous UI state.
   */
  async restoreUIState() {
    // Restore UI alignment.
    if (this.isBrowserUIEnabled) {
      const leftAlignmentEnabled = Services.prefs.getBoolPref(
        "devtools.responsive.leftAlignViewport.enabled",
        false
      );

      this.updateUIAlignment(leftAlignmentEnabled);
    }

    const hasDeviceState = await this.hasDeviceState();
    if (hasDeviceState) {
      // Return if there is a device state to restore, this will be done when the
      // device list is loaded after the post-init.
      return;
    }

    const height = Services.prefs.getIntPref(
      "devtools.responsive.viewport.height",
      0
    );
    const width = Services.prefs.getIntPref(
      "devtools.responsive.viewport.width",
      0
    );
    this.updateViewportSize(width, height);
  }

  /**
   * Restores the previous actor state.
   */
  async restoreActorState() {
    if (this.isBrowserUIEnabled) {
      // It's possible the target will switch to a page loaded in the parent-process
      // (i.e: about:robots). When this happens, the values set on the BrowsingContext
      // by RDM are not preserved. So we need to set setDocumentInRDMPane = true whenever
      // there is a target switch.
      await this.responsiveFront.setDocumentInRDMPane(true);
    }

    const hasDeviceState = await this.hasDeviceState();
    if (hasDeviceState) {
      // Return if there is a device state to restore, this will be done when the
      // device list is loaded after the post-init.
      return;
    }

    const height = Services.prefs.getIntPref(
      "devtools.responsive.viewport.height",
      0
    );
    const pixelRatio = Services.prefs.getIntPref(
      "devtools.responsive.viewport.pixelRatio",
      0
    );
    const touchSimulationEnabled = Services.prefs.getBoolPref(
      "devtools.responsive.touchSimulation.enabled",
      false
    );
    const userAgent = Services.prefs.getCharPref(
      "devtools.responsive.userAgent",
      ""
    );
    const width = Services.prefs.getIntPref(
      "devtools.responsive.viewport.width",
      0
    );

    const { type, angle } = this.getInitialViewportOrientation({
      width,
      height,
    });

    await this.updateDPPX(pixelRatio);
    await this.updateScreenOrientation(type, angle);

    let reloadNeeded = false;
    if (touchSimulationEnabled) {
      reloadNeeded |=
        (await this.updateTouchSimulation(touchSimulationEnabled)) &&
        this.reloadOnChange("touchSimulation");
    }
    if (userAgent) {
      reloadNeeded |=
        (await this.updateUserAgent(userAgent)) &&
        this.reloadOnChange("userAgent");
    }
    if (reloadNeeded) {
      this.getViewportBrowser().reload();
    }
  }

  /**
   * Set or clear the emulated device pixel ratio.
   *
   * @return boolean
   *         Whether a reload is needed to apply the change.
   *         (This is always immediate, so it's always false.)
   */
  async updateDPPX(dppx) {
    if (!dppx) {
      await this.responsiveFront.clearDPPXOverride();
      return false;
    }
    await this.responsiveFront.setDPPXOverride(dppx);
    return false;
  }

  /**
   * Set or clear network throttling.
   *
   * @return boolean
   *         Whether a reload is needed to apply the change.
   *         (This is always immediate, so it's always false.)
   */
  async updateNetworkThrottling(enabled, profile) {
    if (!enabled) {
      await this.responsiveFront.clearNetworkThrottling();
      return false;
    }
    const data = throttlingProfiles.find(({ id }) => id == profile);
    const { download, upload, latency } = data;
    await this.responsiveFront.setNetworkThrottling({
      downloadThroughput: download,
      uploadThroughput: upload,
      latency,
    });
    return false;
  }

  /**
   * Set or clear the emulated user agent.
   *
   * @return boolean
   *         Whether a reload is needed to apply the change.
   */
  updateUserAgent(userAgent) {
    if (!userAgent) {
      return this.responsiveFront.clearUserAgentOverride();
    }
    return this.responsiveFront.setUserAgentOverride(userAgent);
  }

  /**
   * Set or clear touch simulation. When setting to true, this method will
   * additionally set meta viewport override if the pref
   * "devtools.responsive.metaViewport.enabled" is true. When setting to
   * false, this method will clear all touch simulation and meta viewport
   * overrides, returning to default behavior for both settings.
   *
   * @return boolean
   *         Whether a reload is needed to apply the override change(s).
   */
  async updateTouchSimulation(enabled) {
    let reloadNeeded;
    if (enabled) {
      const metaViewportEnabled = Services.prefs.getBoolPref(
        "devtools.responsive.metaViewport.enabled",
        false
      );

      reloadNeeded = await this.responsiveFront.setTouchEventsOverride(
        Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_ENABLED
      );

      if (metaViewportEnabled) {
        reloadNeeded |= await this.responsiveFront.setMetaViewportOverride(
          Ci.nsIDocShell.META_VIEWPORT_OVERRIDE_ENABLED
        );
      }
    } else {
      reloadNeeded = await this.responsiveFront.clearTouchEventsOverride();
      reloadNeeded |= await this.responsiveFront.clearMetaViewportOverride();
    }
    return reloadNeeded;
  }

  /**
   * Sets the screen orientation values of the simulated device.
   *
   * @param {String} type
   *        The orientation type to update the current device screen to.
   * @param {Number} angle
   *        The rotation angle to update the current device screen to.
   * @param {Boolean} isViewportRotated
   *        Whether or not the reason for updating the screen orientation is a result
   *        of actually rotating the device via the RDM toolbar. If true, then an
   *        "orientationchange" event is simulated. Otherwise, the screen orientation is
   *        updated because of changing devices, opening RDM, or the page has been
   *        reloaded/navigated to, so we should not be simulating "orientationchange".
   */
  async updateScreenOrientation(type, angle, isViewportRotated = false) {
    const simulateOrientationChangeSupported = await this.currentTarget.actorHasMethod(
      "responsive",
      "simulateScreenOrientationChange"
    );

    // Ensure that simulateScreenOrientationChange is supported.
    if (simulateOrientationChangeSupported) {
      await this.responsiveFront.simulateScreenOrientationChange(
        type,
        angle,
        isViewportRotated
      );
    }

    // Used by tests.
    if (!isViewportRotated) {
      this.emit("only-viewport-orientation-changed");
    }
  }

  /**
   * Sets whether or not the RDM UI should be left-aligned.
   *
   * @param {Boolean} leftAlignmentEnabled
   *        Whether or not the UI is left-aligned.
   */
  updateUIAlignment(leftAlignmentEnabled) {
    this.browserContainerEl.classList.toggle(
      "left-aligned",
      leftAlignmentEnabled
    );
  }

  /**
   * Sets the browser element to be the given width and height.
   *
   * @param {Number} width
   *        The viewport's width.
   * @param {Number} height
   *        The viewport's height.
   */
  updateViewportSize(width, height) {
    if (!this.isBrowserUIEnabled) {
      return;
    }

    const zoom = this.tab.linkedBrowser.fullZoom;

    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;

    // Setting this with a variable on the stack instead of directly as width/height
    // on the <browser> because we'll need to use this for the alert dialog as well.
    this.browserStackEl.style.setProperty("--rdm-width", `${scaledWidth}px`);
    this.browserStackEl.style.setProperty("--rdm-height", `${scaledHeight}px`);
  }

  /**
   * Helper for tests. Assumes a single viewport for now.
   */
  getViewportSize() {
    if (!this.isBrowserUIEnabled) {
      return this.toolWindow.getViewportSize();
    }

    return this.rdmFrame.contentWindow.getViewportSize();
  }

  /**
   * Helper for tests, etc. Assumes a single viewport for now.
   */
  async setViewportSize(size) {
    await this.inited;
    if (!this.isBrowserUIEnabled) {
      this.toolWindow.setViewportSize(size);
      return;
    }

    const { width, height } = size;
    this.updateViewportSize(width, height);
  }

  /**
   * Helper for tests/reloading the viewport. Assumes a single viewport for now.
   */
  getViewportBrowser() {
    if (!this.isBrowserUIEnabled) {
      return this.toolWindow.getViewportBrowser();
    }

    return this.tab.linkedBrowser;
  }

  /**
   * Helper for contacting the viewport content. Assumes a single viewport for now.
   */
  getViewportMessageManager() {
    return this.getViewportBrowser().messageManager;
  }

  /**
   * Helper for getting the initial viewport orientation.
   */
  getInitialViewportOrientation(viewport) {
    return getOrientation(viewport, viewport);
  }

  /**
   * Helper for tests to get the browser's window.
   */
  getBrowserWindow() {
    if (!this.isBrowserUIEnabled) {
      return this.toolWindow;
    }

    return this.browserWindow;
  }

  async onTargetAvailable({ targetFront }) {
    this.responsiveFront = await targetFront.getFront("responsive");
    await this.restoreActorState();
  }

  async onRemotenessChange(event) {
    const isTargetSwitchingEnabled = Services.prefs.getBoolPref(
      "devtools.target-switching.enabled",
      false
    );

    // We should ignore the remoteness events in case of old RDM
    // as it is firing fake remoteness events.
    if (isTargetSwitchingEnabled && this.isBrowserUIEnabled) {
      const newTarget = await this.client.mainRoot.getTab();
      await this.targetList.switchToTarget(newTarget);
    } else {
      const { browserWindow, tab } = this;
      this.manager.closeIfNeeded(browserWindow, tab, {
        reason: event.type,
      });
    }
  }
}

module.exports = ResponsiveUI;
