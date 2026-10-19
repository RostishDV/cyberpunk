export function registerSystemSettings() {
  /** Last system version that ran migrations */
  game.settings.register("cyberpunk", "systemMigrationVersion", {
    name: "SETTINGS.SysMigration",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  /**
   * Campaign start date (text input, parsed as UTC date)
   */
  game.settings.register("cyberpunk", "campaignStartDate", {
    name: "SETTINGS.CampaignStartDate",
    hint: "SETTINGS.CampaignStartDateHint",
    scope: "world",
    config: true,
    type: String,
    default: "2045-01-01 00:00:00"
  });

  /**
   * Хомбрю Палыча по автофаерам.
   */
  game.settings.register("cyberpunk", "palychFullautoEnabled", {
    name: "Palych full auto homebrew",
    hint: "Removes difficulty change from autofire",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  /**
   * Хомбрю палыча по очередям.
   */
  game.settings.register("cyberpunk", "palychBurstEnabled", {
    name: "Palych bursts homebrew",
    hint: "Changes burst difficults and hitted",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  /**
   * Возвращение базовой системы человечности.
   */
  game.settings.register("cyberpunk", "useDefaultHumanity", {
    name: "Use core 2020 hummanity",
    hint: "Changes hummanity to 10pts per 1 EMP",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  /**
   * Добавление поля доп.модификаторы во все проверки.
   */
  game.settings.register("cyberpunk", "additionalModsForChecksEnable", {
    name: "Enable additional modes field",
    hint: "Adds field 'additional mod' for every roll dialog",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  /**
   * Game time offset from campaign start (ms). Hidden setting.
   * onChange: drug effects key their phase-expiration to this clock, so any
   * advancement (combat round, calendar dialog) re-checks every active drug
   * effect for wear-off / phase swap. Runs on the active GM only.
   */
  game.settings.register("cyberpunk", "gameTimeOffset", {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
    onChange: async () => {
      const { checkDrugEffectExpiration } = await import("./drug-effects.js");
      const { checkNetwareEffectExpiration } = await import("./netrun/netware-effects.js");
      await Promise.all([checkDrugEffectExpiration(), checkNetwareEffectExpiration()]);
      // Refresh any open actor sheet with a live drug row so the
      // remaining-time chip in the State tab ticks with the clock,
      // not only when a phase actually swaps. Fires on every client
      // (the setting is world-scoped, so onChange runs everywhere) so
      // each player's open sheet reflects the new time.
      for (const app of Object.values(ui.windows)) {
        if (app?.actor?.effects?.some?.(e => (e.getFlag?.("cyberpunk", "isDrugEffect") === true || e.getFlag?.("cyberpunk", "isNetwareEffect") === true))) {
          app.render(false);
        }
      }
      const v2Registry = foundry.applications?.instances;
      if (v2Registry) {
        for (const app of v2Registry.values()) {
          const actor = app?.document?.documentName === "Actor" ? app.document : null;
          if (actor?.effects?.some?.(e => (e.getFlag?.("cyberpunk", "isDrugEffect") === true || e.getFlag?.("cyberpunk", "isNetwareEffect") === true))) {
            app.render(false);
          }
        }
      }
    }
  });
}
