/**
 * Shop trading — buy / sell logic. Mirrors the cross-character transfer flow
 * but layers eurobucks movement on top, and posts a different chat message.
 *
 * Conceptually buying is "shop → buyer" with eddies going "buyer → shop",
 * and selling is the inverse. Both flow through `moveItemForTrade()`.
 *
 * Shops stock every item type as a counted stack (one document, `quantity`
 * copies). Characters keep that shape only for the genuinely stackable types
 * (drug doses, ammo rounds, ordnance count); every other item lives on a
 * character as one document per item.
 */
import { MoveItemsDialog } from "../dialog/move-items-dialog.js";
import { detachAllChildren, isStackable, findMergeTarget } from "./item-transfer.js";
import { renderTemplateCompat } from "../utils.js";

const EUROBUCKS_PATH = "system.gear.eurobucks";

/** Document fields that never distinguish one unit of stock from another. */
const STACK_KEY_IGNORED = ["quantity", "equipped", "sourceUuid", "lastOwnerId", "attachedTo"];

/** Ammo is the one item type whose stock is counted in rounds but traded in packs. */
export function isAmmo(item) {
  return item.type === "weapon" && item.system?.weaponType === "Ammo";
}

/**
 * Stock held by a document, in its own storage units (ammo: rounds;
 * everything else: doses / items). An unset or zero quantity counts as one
 * unit — one pack for ammo — matching how legacy rows have always displayed.
 */
export function stockQuantity(item) {
  const sys = item.system ?? {};
  if (isAmmo(item)) {
    const packSize = Math.max(1, Number(sys.packSize) || 1);
    return Math.max(1, Number(sys.quantity) || packSize);
  }
  return Math.max(1, Math.floor(Number(sys.quantity) || 1));
}

/**
 * Express a tradeable item in "trade unit" terms.
 *   ammo   → 1 unit = 1 pack,           perUnitRounds = packSize
 *   other  → 1 unit = 1 dose / 1 item,  perUnitRounds = 1
 * Shop stock of any type is a counted stack; on a character only stackable
 * types carry a count — a character's pistol is a single unit. The Buy / Sell
 * quantity dialog is bounded by `units`, and the underlying `system.quantity`
 * moves by `tradeQty * perUnitRounds`. `priceMultiplier` (e.g. 0.75 for a
 * 75 % sell shop) scales the per-unit cost — applied here, not at the display
 * layer, so the price the buyer sees is exactly the price they're charged.
 */
export function tradeUnitInfo(item, priceMultiplier = 1) {
  const baseCost = Number(item.system?.cost) || 0;
  const perUnitCost = Math.max(0, Math.round(baseCost * priceMultiplier));
  if (isAmmo(item)) {
    const perUnitRounds = Math.max(1, Number(item.system?.packSize) || 1);
    return {
      units: Math.max(1, Math.floor(stockQuantity(item) / perUnitRounds)),
      perUnitRounds,
      perUnitCost
    };
  }
  const counted = item.parent?.type === "shop" || isStackable(item);
  return { units: counted ? stockQuantity(item) : 1, perUnitRounds: 1, perUnitCost };
}

/** Read the shop's price multiplier for the given side ("buy" or "sell"). */
function shopPriceMultiplier(shop, side) {
  const key = side === "buy" ? "buyPricePct" : "sellPricePct";
  const raw = shop?.system?.settings?.[key];
  const pct = Math.max(1, Math.min(200, Number(raw) || (side === "buy" ? 100 : 50)));
  return pct / 100;
}

function getEurobucks(actor) {
  return Number(actor.system?.gear?.eurobucks) || 0;
}

/**
 * Sellable means "not currently in active use" — equipped off, drug not in
 * the active phase, and not currently attached to a parent item (cyberware /
 * armor options via the flag, weapon options via `system.attachedTo`).
 */
export function isSellable(item) {
  if (item.system?.equipped) return false;
  if (item.type === "drug" && item.system?.phase === "active") return false;
  if (item.getFlag?.("cyberpunk", "attachedTo")) return false;
  if (item.system?.attachedTo) return false;
  return true;
}

/**
 * Factory-reset plain document data (`item.toObject()`) in place before it
 * changes hands. Mirrors `buildTransferData` in item-transfer.js — keep the
 * two in sync.
 */
export function resetForTrade(data) {
  if (!data?.system) return;
  const s = data.system;
  data.system.equipped = false;
  switch (data.type) {
    case "weapon": {
      if (s.shots != null) data.system.shotsLeft = s.shots;
      if (s.chargesMax)    data.system.charges   = s.chargesMax;
      if (s.attachedAmmoId) {
        data.system.attachedAmmoId = "";
        data.system.shotsLeft = 0;
      }
      // Weapon options leave their weapon behind.
      if (s.attachedTo) data.system.attachedTo = "";
      break;
    }
    case "armor": {
      if (s.coverage) {
        for (const loc of Object.keys(s.coverage)) {
          if (data.system.coverage[loc]) data.system.coverage[loc].ablation = 0;
        }
      }
      break;
    }
    case "cyberware": {
      if (s.structure?.max) data.system.structure.current = s.structure.max;
      data.system.humanityLoss = 0;
      data.system.humanityRolled = false;
      if (s.weapon?.shots != null) data.system.weapon.shotsLeft = s.weapon.shots;
      if (s.weapon?.chargesMax)    data.system.weapon.charges   = s.weapon.chargesMax;
      if (s.weapon?.attachedAmmoId) {
        data.system.weapon.attachedAmmoId = "";
        data.system.weapon.shotsLeft = 0;
      }
      break;
    }
  }
  // Strip attachment flag — items in a shop are unattached.
  const flagsCp = foundry.utils.getProperty(data, "flags.cyberpunk");
  if (flagsCp && "attachedTo" in flagsCp) delete flagsCp.attachedTo;
}

/** JSON with object keys sorted, so field order never splits a stack. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Identity of a shop stack. Two items share a key — and so a shop row — when
 * they're interchangeable once factory-reset for trade: same type, name
 * (case-insensitive), image, system data and embedded effects, ignoring the
 * count itself, equip state and provenance / attachment ids. An item a GM
 * customised keeps its own row instead of being merged away. Accepts a
 * document or plain document data.
 */
export function shopStackKey(itemOrData) {
  const data = typeof itemOrData.toObject === "function"
    ? itemOrData.toObject()
    : foundry.utils.deepClone(itemOrData);
  resetForTrade(data);
  const system = { ...(data.system ?? {}) };
  for (const field of STACK_KEY_IGNORED) delete system[field];
  const effects = (data.effects ?? []).map(({ _id, _stats, origin, ...effect }) => effect);
  return stableStringify({
    type: data.type,
    name: (data.name ?? "").trim().toLowerCase(),
    img: data.img,
    system,
    effects
  });
}

/**
 * Move `qty` stock units (rounds for ammo) of `sourceItem` from its owner to
 * `targetActor`, factory-resetting along the way.
 *
 * Taking: a shop stack, or a character's stackable item, decrements (deleting
 * at zero). Any other character item is a single document — its attached
 * children are detached (they stay with the seller) and it moves whole.
 * Giving: a shop merges into the matching stack (`shopStackKey`); a character
 * merges stackables into its existing stack and receives every other item as
 * `qty` individual documents.
 */
async function moveItemForTrade(sourceItem, targetActor, qty) {
  const sourceActor = sourceItem.parent;
  const stackable = isStackable(sourceItem);

  if (sourceActor.type === "shop" || stackable) {
    const sourceQty = stockQuantity(sourceItem);
    if (qty < sourceQty) {
      await sourceActor.updateEmbeddedDocuments("Item", [{
        _id: sourceItem.id,
        "system.quantity": sourceQty - qty
      }]);
    } else {
      await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
    }
  } else {
    // Weapons are sold unloaded; options stay with the seller.
    await detachAllChildren(sourceItem);
    await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  }

  const data = sourceItem.toObject();
  delete data._id;
  resetForTrade(data);

  if (targetActor.type === "shop") {
    const key = shopStackKey(data);
    const existing = targetActor.items.find(i => shopStackKey(i) === key);
    if (existing) {
      await targetActor.updateEmbeddedDocuments("Item", [{
        _id: existing.id,
        "system.quantity": stockQuantity(existing) + qty
      }]);
    } else {
      data.system.quantity = qty;
      await targetActor.createEmbeddedDocuments("Item", [data]);
    }
    return;
  }

  if (stackable) {
    const existing = findMergeTarget(sourceItem, targetActor);
    if (existing) {
      await targetActor.updateEmbeddedDocuments("Item", [{
        _id: existing.id,
        "system.quantity": (Number(existing.system?.quantity) || 0) + qty
      }]);
    } else {
      data.system.quantity = qty;
      await targetActor.createEmbeddedDocuments("Item", [data]);
    }
    return;
  }

  data.system.quantity = 1;
  await targetActor.createEmbeddedDocuments("Item",
    Array.from({ length: qty }, () => foundry.utils.deepClone(data)));
}

/**
 * Adjust both actor tills by the trade total. Buying: buyer pays, shop
 * receives. Selling: shop pays, seller receives.
 */
async function transferEurobucks(payer, payee, amount) {
  const payerBalance = getEurobucks(payer);
  const payeeBalance = getEurobucks(payee);
  await payer.update({ [EUROBUCKS_PATH]: Math.max(0, payerBalance - amount) });
  await payee.update({ [EUROBUCKS_PATH]: payeeBalance + amount });
}

/**
 * Post a Bought/Sold chat message from the buying/selling CHARACTER (not the
 * shop). Sections reuse the existing section-bar partial and target-info
 * styling so the look matches Gave / To from the cross-character transfer.
 *
 * @param {"buy"|"sell"} mode
 */
async function postTradeMessage(mode, character, shop, item, count) {
  const content = await renderTemplateCompat(
    "systems/cyberpunk/templates/chat/item-trade.hbs",
    {
      // Resolved labels (template can't do inline if/ternary, so we pick here)
      actionLabel: game.i18n.localize(mode === "buy" ? "CYBERPUNK.Bought" : "CYBERPUNK.Sold"),
      partyLabel:  game.i18n.localize(mode === "buy" ? "CYBERPUNK.From"   : "CYBERPUNK.To"),
      itemImg:    item.img,
      itemName:   item.name,
      count,
      shopImg:    shop.img,
      shopName:   shop.name
    }
  );
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: character }),
    content
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Buy `item` from `shop` on behalf of `buyer`. Pops the Buy Items dialog
 * whenever the stack holds more than one trade unit. Cost is
 * `perUnitCost × tradeQty`; underlying quantity moved is
 * `tradeQty × perUnitRounds` (so an ammo pack of 20 transfers 20 rounds per
 * pack). Returns true on success, false if cancelled or unaffordable.
 */
export async function buyItem(buyer, shop, item) {
  if (!buyer || !shop || !item) return false;
  const { units, perUnitRounds, perUnitCost } = tradeUnitInfo(item, shopPriceMultiplier(shop, "buy"));

  let tradeQty = 1;
  if (units > 1) {
    const dlg = new MoveItemsDialog(units, item.name, {
      titleKey: "BuyItemsTitle",
      buttonKey: "Buy"
    });
    tradeQty = await dlg.prompt();
    if (tradeQty == null) return false;
    tradeQty = Math.min(units, Math.max(1, Math.floor(tradeQty)));
  }

  const total = perUnitCost * tradeQty;
  if (getEurobucks(buyer) < total) {
    ui.notifications.warn(game.i18n.localize("CYBERPUNK.NotEnoughEurobucks"));
    return false;
  }

  await transferEurobucks(buyer, shop, total);
  await moveItemForTrade(item, buyer, tradeQty * perUnitRounds);
  await postTradeMessage("buy", buyer, shop, item, tradeQty);
  return true;
}

/**
 * Sell `item` from `seller` to `shop`. Same trade-unit logic as `buyItem`;
 * weapons / armor / cyberware get their attachments detached (children stay
 * with the seller), then the clean parent joins the shop's matching stack.
 */
export async function sellItem(seller, shop, item) {
  if (!seller || !shop || !item) return false;
  const { units, perUnitRounds, perUnitCost } = tradeUnitInfo(item, shopPriceMultiplier(shop, "sell"));

  let tradeQty = 1;
  if (units > 1) {
    const dlg = new MoveItemsDialog(units, item.name, {
      titleKey: "SellItemsTitle",
      buttonKey: "Sell"
    });
    tradeQty = await dlg.prompt();
    if (tradeQty == null) return false;
    tradeQty = Math.min(units, Math.max(1, Math.floor(tradeQty)));
  }

  const total = perUnitCost * tradeQty;
  if (getEurobucks(shop) < total) {
    ui.notifications.warn(game.i18n.localize("CYBERPUNK.ShopCantAfford"));
    return false;
  }

  await transferEurobucks(shop, seller, total);
  await moveItemForTrade(item, shop, tradeQty * perUnitRounds);
  await postTradeMessage("sell", seller, shop, item, tradeQty);
  return true;
}
