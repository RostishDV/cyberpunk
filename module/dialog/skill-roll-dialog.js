import { localize } from "../utils.js";
import { NumberInput } from "./number-input.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Skill/Attribute Roll Dialog — select difficulty and modifiers before rolling.
 * @extends {ApplicationV2}
 */
export class SkillRollDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(actor, options = {}) {
    super({});
    this.actor = actor;
    this.rollType = options.rollType || "skill";
    this.skillId = options.skillId || null;
    this.statName = options.statName || null;
    this._dialogTitle = options.title || localize("Skill");
    this.statIcon = options.statIcon || null;
    this._difficulty = 15;
    this._conditions = { prepared: false, distracted: false };
    this._luckToSpend = 0;
    this._availableLuck = actor.system.stats.luck?.effective ??
                          actor.system.stats.luck?.total ?? 0;
    this._additionalMods = 0;
  }

  static DEFAULT_OPTIONS = {
    id: "skill-roll-dialog",
    classes: ["cyberpunk", "skill-roll-dialog"],
    position: { width: 300, height: "auto" },
    window: { frame: true, positioned: true, resizable: false, minimizable: false, controls: [] },
    actions: {
      closeDialog:          SkillRollDialog._onCloseDialog,
      toggleCondition:      SkillRollDialog._onToggleCondition,
      luckPlus:             SkillRollDialog._onLuckPlus,
      luckMinus:            SkillRollDialog._onLuckMinus,
      additionalModsPlus:   SkillRollDialog._onAdditionalModsPlus,
      additionalModsMinus:  SkillRollDialog._onAdditionalModsMinus,
      roll:                 SkillRollDialog._onRoll
    }
  };

  static PARTS = {
    body: { template: "systems/cyberpunk/templates/dialog/skill-roll.hbs" }
  };

  get title() { return this._dialogTitle; }

  static _onCloseDialog(event, _target) { event?.preventDefault?.(); this.close({ animate: false }); }

  static _onToggleCondition(event, target) {
    event?.preventDefault?.();
    const condition = target?.dataset?.condition;
    if (!condition) return;
    this._conditions[condition] = !this._conditions[condition];
    target.classList.toggle('selected', this._conditions[condition]);
  }

  static _onLuckPlus(event, _target) {
    event?.preventDefault?.();
    if (this._luckToSpend < this._availableLuck) { this._luckToSpend++; this._updateLuckDisplay(); }
  }

  static _onLuckMinus(event, _target) {
    event?.preventDefault?.();
    if (this._luckToSpend > 0) { this._luckToSpend--; this._updateLuckDisplay(); }
  }

  static _onRoll(event, _target) { event?.preventDefault?.(); this._executeRoll(); }

  async _prepareContext(_options) {
    return {
      title: this._dialogTitle,
      statIcon: this.statIcon,
      difficulty: this._difficulty,
      conditions: this._conditions,
      luckToSpend: this._luckToSpend,
      availableLuck: this._availableLuck,
      canIncreaseLuck: this._luckToSpend < this._availableLuck,
      canDecreaseLuck: this._luckToSpend > 0,
      hasAnyLuck: this._availableLuck > 0,
      additionalModsVisible: game.settings.get('cyberpunk', 'additionalModsForChecksEnable'),
      additionalMods: this._additionalMods
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const header = this.element.querySelector('.reload-header');
    if (header) {
      new foundry.applications.ux.Draggable.implementation(this, this.element, header, false);
    }
    const $el = $(this.element);
    this._difficultyInput = new NumberInput($el, '.difficulty-input-wrap', {
      min: 10, max: 40, step: 5, value: this._difficulty,
      onChange: (v) => { this._difficulty = v; }
    });
  }

  _updateLuckDisplay() {
    const luckVal = this.element.querySelector('.luck-value');
    if (luckVal) luckVal.textContent = this._luckToSpend;
    const minusDisabled = this._luckToSpend <= 0;
    const plusDisabled = this._luckToSpend >= this._availableLuck;
    const minusBtn = this.element.querySelector('.luck-minus-btn');
    const plusBtn = this.element.querySelector('.luck-plus-btn');
    minusBtn?.classList.toggle('disabled', minusDisabled);
    plusBtn?.classList.toggle('disabled', plusDisabled);
    minusBtn?.querySelector('img')?.setAttribute('src',
      `systems/cyberpunk/img/chat/${minusDisabled ? 'minus-disabled' : 'minus'}.svg`);
    plusBtn?.querySelector('img')?.setAttribute('src',
      `systems/cyberpunk/img/chat/${plusDisabled ? 'plus-disabled' : 'plus'}.svg`);
  }

  static _onAdditionalModsMinus(event, _target) {
    event?.preventDefault?.();
    this._additionalMods--; 
    this._updateAdditionalModsDisplay();
  }

  static _onAdditionalModsPlus(event, _target) {
    event?.preventDefault?.();
    this._additionalMods++; 
    this._updateAdditionalModsDisplay();
  }

  _updateAdditionalModsDisplay() {
    const luckVal = this.element.querySelector('.additional-value');
    if (luckVal) luckVal.textContent = this._additionalMods;
  }

  async _executeRoll() {
    const conditionMod = (this._conditions.prepared ? 2 : 0) +
                         (this._conditions.distracted ? -2 : 0);
    let extraMod = conditionMod + this._luckToSpend;

    if (this._luckToSpend > 0) {
      const currentSpent = this.actor.system.stats.luck.spent || 0;
      const currentSpentAt = this.actor.system.stats.luck.spentAt;
      this.actor.update({
        "system.stats.luck.spent": currentSpent + this._luckToSpend,
        "system.stats.luck.spentAt": currentSpentAt || Date.now()
      });
    }

    if (game.settings.get('cyberpunk', 'additionalModsForChecksEnable') 
      && this._additionalMods !== 0) {
      extraMod += this._additionalMods;
    }

    this.close({ animate: false });

    if (this.rollType === "skill") {
      this.actor.rollSkillCheck(this.skillId, this._difficulty, extraMod);
    } else {
      this.actor.rollStatCheck(this.statName, this._difficulty, extraMod);
    }

    const { registerAction } = await import("../action-tracker.js");
    const actionType = this.rollType === "skill" ? "skill roll" : "stat roll";
    await registerAction(this.actor, actionType);
  }
}
