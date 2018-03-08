"use strict";

/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(EXPORTED_SYMBOLS|Feature)" }]*/

const { utils: Cu } = Components;
Cu.import("resource://gre/modules/Console.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/ClientID.jsm");
Cu.import("resource://gre/modules/TelemetryEnvironment.jsm");
Cu.import("resource://gre/modules/TelemetryController.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");

const EXPORTED_SYMBOLS = ["Feature"];

const PREF_BRANCH = "extensions.taarexpv2";
const SHIELD_STUDY_ADDON_ID = "taarexpv2@shield.mozilla.org";
const CLIENT_STATUS_PREF = PREF_BRANCH + ".client-status";

XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow",
  "resource:///modules/RecentWindow.jsm");

/** Return most recent NON-PRIVATE browser window, so that we can
 * manipulate chrome elements on it.
 */

/*
function getMostRecentBrowserWindow() {
  return RecentWindow.getMostRecentBrowserWindow({
    private: false,
    allowPopups: false,
  });
}
*/

// unit-tested study helpers
XPCOMUtils.defineLazyModuleGetter(
  this, "Helpers", "resource://taarexpv2/lib/Helpers.jsm"
);

class Client {
  constructor(feature) {
    this.feature = feature;
    const clientStatusJson = Preferences.get(CLIENT_STATUS_PREF);
    if (clientStatusJson && clientStatusJson !== "") {
      this.status = JSON.parse(clientStatusJson);
    } else {
      this.status = {};
      this.status.discoPaneLoaded = false;
      this.status.clickedButton = false;
      this.status.sawPopup = false;
      this.status.startTime = null;
      this.status.totalWebNav = 0;
      this.status.aboutAddonsActiveTabSeconds = 0;
      this.persistStatus();
    }
  }

  getStatus() {
    return this.status;
  }

  setAndPersistStatus(key, value) {
    this.status[key] = value;
    this.persistStatus();
  }

  incrementAndPersistClientStatusAboutAddonsActiveTabSeconds() {
    this.status.aboutAddonsActiveTabSeconds++;
    this.persistStatus();
  }

  persistStatus() {
    Preferences.set(CLIENT_STATUS_PREF, JSON.stringify(this.status));
  }

  resetStatus() {
    Preferences.set(CLIENT_STATUS_PREF, "");
  }

  static analyzeAddonChangesBetweenEnvironments(oldEnvironment, currentEnvironment) {
    const prev = Client.activeNonSystemAddonIdsInEnvironment(oldEnvironment);
    const curr = Client.activeNonSystemAddonIdsInEnvironment(currentEnvironment);
    return Helpers.analyzeAddonChanges(prev, curr);
  }

  static activeNonSystemAddonIdsInEnvironment(environment) {
    const activeAddons = environment.addons.activeAddons;
    const result = new Set();
    for (const addonId in activeAddons) {
      // Do not count this extension
      if (addonId === SHIELD_STUDY_ADDON_ID) {
        continue;
      }
      const data = activeAddons[addonId];
      if (!data.isSystem && !data.foreignInstall) {
        result.add(addonId);
      }
    }
    return result;
  }

  static bucketURI(uri) {
    if (uri !== "about:addons") {
      if (uri.indexOf("addons.mozilla.org") > 0) {
        uri = "AMO";
      } else {
        uri = "other";
      }
    }
    return uri;
  }

  monitorAddonChanges() {

    // Prevent a dangling change listener (left after add-on uninstallation) to do anything
    if (!TelemetryEnvironment) {
      this.feature.log.debug("monitorAddonChanges disabled since TelemetryEnvironment is not available - a dangling change listener to do unclean add-on uninstallation?");
      return;
    }

    TelemetryEnvironment.registerChangeListener("addonListener", (change, oldEnvironment) => Client.addonChangeListener(change, oldEnvironment, this, this.feature));

  }

  static addonChangeListener(change, oldEnvironment, client, feature) {

    // Prevent a dangling change listener (left after add-on uninstallation) to do anything
    if (!TelemetryEnvironment) {
      feature.log.debug("addonChangeListener disabled since TelemetryEnvironment is not available - a dangling change listener to do unclean add-on uninstallation?");
      return null;
    }

    if (change === "addons-changed") {
      const addonChanges = Client.analyzeAddonChangesBetweenEnvironments(oldEnvironment, TelemetryEnvironment.currentEnvironment);
      const uri = Client.bucketURI(Services.wm.getMostRecentWindow("navigator:browser").gBrowser.currentURI.asciiSpec);
      if (addonChanges.lastInstalled) {
        // feature.log.debug("Just installed", client.lastInstalled, "from", uri);

        // send telemetry
        const dataOut = {
          "addon_id": String(addonChanges.lastInstalled),
          "srcURI": String(uri),
          "pingType": "install",
        };
        feature.notifyViaTelemetry(dataOut);

      } else if (addonChanges.lastDisabledOrUninstalled) {
        // feature.log.debug("Just disabled", client.lastDisabledOrUninstalled, "from", uri);

        // send telemetry
        const dataOut = {
          "addon_id": String(addonChanges.lastDisabledOrUninstalled),
          "srcURI": String(uri),
          "pingType": "uninstall",
        };
        feature.notifyViaTelemetry(dataOut);

      }

    }

    // eslint
    return null;

  }

}

function getPageActionUrlbarIcon() {

  const window = Services.wm.getMostRecentWindow("navigator:browser");
  // Id reference style as was working in taar v1
  let pageActionUrlbarIcon = window.document.getElementById("taarexpv2_shield_mozilla_org-page-action");
  // Firefox 57+
  if (!pageActionUrlbarIcon) {
    pageActionUrlbarIcon = window.document.getElementById("pageAction-urlbar-taarexpv2_shield_mozilla_org");
  }
  if (!pageActionUrlbarIcon) {
    throw new PageActionUrlbarIconElementNotFoundError([window.document, pageActionUrlbarIcon, window.document.querySelectorAll(".urlbar-page-action")]);
  }
  return pageActionUrlbarIcon;

}

class PageActionUrlbarIconElementNotFoundError extends Error {
  constructor(debugInfo) {
    const message = `"Error: TAAR V2 study add-on page action element not found. Debug content: window.document, pageActionUrlbarIcon, all urlbar page action classed elements: ${debugInfo.toString()}`;
    super(message);
    this.message = message;
    this.debugInfo = debugInfo;
    this.name = "PageActionUrlbarIconElementNotFoundError";
  }
}

/**
 * Note: The page action popup should already be closed via it's own javascript's window.close() after any button is called
 * but it will also close when we hide the page action urlbar icon via this method
 */
function hidePageActionUrlbarIcon() {
  try {
    const pageActionUrlbarIcon = getPageActionUrlbarIcon();
    pageActionUrlbarIcon.remove();
  } catch (e) {
    if (e.name === "PageActionUrlbarIconElementNotFoundError") {
      // All good, no element found
    }
  }
}

class Feature {
  /** A Demonstration feature.
   *
   *  - variation: study info about particular client study variation
   *  - studyUtils:  the configured studyUtils singleton.
   *  - reasonName: string of bootstrap.js startup/shutdown reason
   *
   */
  constructor({ variation, studyUtils, reasonName, log }) {

    this.variation = variation;
    this.studyUtils = studyUtils;
    this.client = new Client(this);
    this.log = log;

    // reset client status during INSTALL and UPGRADE = a new study period begins
    if (reasonName === "ADDON_INSTALL" || reasonName === "ADDON_UPGRADE") {
      this.client.resetStatus();
    }

    // log what the study variation and other info is.
    this.log.debug(`info ${JSON.stringify(studyUtils.info())}`);

    const clientIdPromise = ClientID.getClientID();

    clientIdPromise.then((clientId) => {

      let aboutAddonsDomain = "https://discovery.addons.mozilla.org/%LOCALE%/firefox/discovery/pane/%VERSION%/%OS%/%COMPATIBILITY_MODE%";
      aboutAddonsDomain += "?study=taarexpv2";
      aboutAddonsDomain += "&branch=" + variation.name;

      // do not supply client id for the control branch
      if (variation.name !== "control") {
        aboutAddonsDomain += "&clientId=" + clientId;
      }

      log.debug(`Study-specific add-ons domain: ${aboutAddonsDomain}`);

      Preferences.set("extensions.webservice.discoverURL", aboutAddonsDomain);

    });

  }

  afterWebExtensionStartup(browser) {

    // to track temporary changing of preference necessary to have about:addons lead to discovery pane directly
    let currentExtensionsUiLastCategoryPreferenceValue = false;

    const client = this.client;
    const self = this;

    client.monitorAddonChanges();

    browser.runtime.onMessage.addListener((msg, sender, sendReply) => {
      self.log.debug("Feature.jsm message handler - msg, sender, sendReply", msg, sender, sendReply);

      // event-based message handlers
      if (msg.init) {
        self.log.debug("init received");
        client.setAndPersistStatus("startTime", String(Date.now()));
        // send telemetry
        const dataOut = {
          "pingType": "init",
        };
        self.notifyViaTelemetry(dataOut);
        sendReply(dataOut);
        return;
      } else if (msg["disco-pane-loaded"]) {
        client.setAndPersistStatus("discoPaneLoaded", true);
        // send telemetry
        const dataOut = {
          "pingType": "disco-pane-loaded",
        };
        self.notifyViaTelemetry(dataOut);
        sendReply({ response: "Disco pane loaded" });
        // restore preference if we changed it temporarily
        if (typeof currentExtensionsUiLastCategoryPreferenceValue !== "undefined" && currentExtensionsUiLastCategoryPreferenceValue !== false) {
          Preferences.set("extensions.ui.lastCategory", currentExtensionsUiLastCategoryPreferenceValue);
        }
        return;
      } else if (msg["trigger-popup"]) {
        if (client.getStatus().discoPaneLoaded === true) {
          self.log.debug("Not triggering popup since disco pane has already been loaded");
          return;
        }
        client.setAndPersistStatus("sawPopup", true);
        try {
          const pageActionUrlbarIcon = getPageActionUrlbarIcon();
          pageActionUrlbarIcon.click();
          // send telemetry
          const dataOut = {
            "pingType": "trigger-popup",
          };
          self.notifyViaTelemetry(dataOut);
          sendReply({ response: "Triggered pop-up" });
        } catch (e) {
          if (e.name === "PageActionUrlbarIconElementNotFoundError") {
            console.error(e);
          }
        }
        return;
      } else if (msg["clicked-disco-button"]) {
        // set pref to force discovery page temporarily so that navigation to about:addons leads directly to the discovery pane
        currentExtensionsUiLastCategoryPreferenceValue = Preferences.get("extensions.ui.lastCategory");
        Preferences.set("extensions.ui.lastCategory", "addons://discover/");
        // navigate to about:addons
        const window = Services.wm.getMostRecentWindow("navigator:browser");
        window.gBrowser.selectedTab = window.gBrowser.addTab("about:addons", { relatedToCurrent: true });
        client.setAndPersistStatus("clickedButton", true);
        hidePageActionUrlbarIcon();
        // send telemetry
        const dataOut = {
          "pingType": "button-click",
        };
        self.notifyViaTelemetry(dataOut);
        sendReply({ response: "Clicked discovery pane button" });
        return;
      } else if (msg["clicked-close-button"]) {
        client.setAndPersistStatus("clickedButton", false);
        hidePageActionUrlbarIcon();
        sendReply({ response: "Closed pop-up" });
        return;
      }

      // getter and setter for client status
      if (msg.getClientStatus) {
        self.log.debug(client.status);
        sendReply(client.getStatus());
      } else if (msg.setAndPersistClientStatus) {
        client.setAndPersistStatus(msg.key, msg.value);
        self.log.debug(client.status);
        sendReply(client.getStatus());
      } else if (msg.incrementAndPersistClientStatusAboutAddonsActiveTabSeconds) {
        client.incrementAndPersistClientStatusAboutAddonsActiveTabSeconds();
        self.log.debug(client.status);
        sendReply(client.getStatus());
      }

    });

  }

  /**
   * Wrapper that ensures that telemetry gets sent in the expected format for the study
   * @param stringStringMap
   */
  notifyViaTelemetry(stringStringMap) {
    const client = this.client;
    stringStringMap.discoPaneLoaded = String(client.status.discoPaneLoaded);
    stringStringMap.clickedButton = String(client.status.clickedButton);
    stringStringMap.sawPopup = String(client.status.sawPopup);
    stringStringMap.startTime = String(client.status.startTime);
    stringStringMap.discoPaneLoaded = String(client.status.discoPaneLoaded);
    stringStringMap.aboutAddonsActiveTabSeconds = String(client.status.aboutAddonsActiveTabSeconds);
    if (typeof stringStringMap.addon_id === "undefined") {
      stringStringMap.addon_id = "null";
    }
    if (typeof stringStringMap.srcURI === "undefined") {
      stringStringMap.srcURI = "null";
    }
    // send telemetry
    this.telemetry(stringStringMap);
  }

  aPrivateBrowserWindowIsOpen() {
    if (PrivateBrowsingUtils.permanentPrivateBrowsing) {
      return true;
    }
    const windowList = Services.wm.getEnumerator("navigator:browser");
    while (windowList.hasMoreElements()) {
      const nextWin = windowList.getNext();
      if (PrivateBrowsingUtils.isWindowPrivate(nextWin)) {
        return true;
      }
    }
    return false;
  }

  telemetry(stringStringMap) {
    if (this.aPrivateBrowserWindowIsOpen()) {
      // drop the ping - do not send any telemetry
      return;
    }
    this.studyUtils.telemetry(stringStringMap);
  }

  /* called at end of study */
  shutdown() {
    // send final telemetry
    const dataOut = {
      "pingType": "shutdown",
    };
    this.notifyViaTelemetry(dataOut);
    // remove artifacts of this study
    var defaultBranch = Services.prefs.getDefaultBranch(null);
    defaultBranch.deleteBranch(PREF_BRANCH);
  }
}


// webpack:`libraryTarget: 'this'`
this.EXPORTED_SYMBOLS = EXPORTED_SYMBOLS;
this.Feature = Feature;
