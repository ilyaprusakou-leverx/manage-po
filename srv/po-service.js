'use strict'
const cds = require('@sap/cds')
const axios = require('axios')
const { loadCredentials } = require('./credentials')

const NS = 'com.sap.gateway.srvd.zpru_purcorderhdr_odata.v0001'
const ZERO_GUID = '00000000-0000-0000-0000-000000000000'

// ── PITFALL: OData V4 draft-enabled service ───────────────────────────────────
// purchaseOrder is the DraftRoot; purchaseItem, ZZPurchaseTag and
// purchaseOrderText are DraftNodes that always share the root's DraftUUID.
// Active instances always carry DraftUUID = ZERO_GUID and IsActiveEntity=true.
// Root (header) can be deleted directly while active; every other write on the
// header, and ALL writes on child nodes (items/tags/texts), must go through
// the Edit -> mutate draft -> Activate cycle (Discard on failure) — this file
// does that internally so every tool only ever accepts/returns active data.
//
// The collection-bound operations (sendOrderStatisticToAzure, getMajorSupplier)
// are invoked below following the OData V4 convention of applying system query
// options to the collection before the bound operation segment. This could not
// be verified against a live system (ADT/system access unavailable while writing
// this) — test these first and adjust the URL construction if the backend
// responds differently.

function httpClient() {
  const creds = loadCredentials()
  const instance = axios.create({
    baseURL: creds.baseUrl + creds.servicePath,
    params: { 'sap-client': creds.client },
    headers: { Accept: 'application/json' },
    auth: { username: creds.user, password: creds.pass },
    timeout: 30000
  })
  return instance
}

// CSRF token required for all mutating requests (POST/PATCH/DELETE).
// The token is bound to the session SAP's gateway opens for this request, so the
// Set-Cookie it returns must be pinned onto this axios instance — otherwise the
// next request (Basic Auth, no cookie) gets a fresh session and the token is
// rejected with "CSRF token is invalid".
async function csrfToken(http) {
  const res = await http.get('/', { headers: { 'x-csrf-token': 'Fetch' } })
  const setCookie = res.headers['set-cookie']
  if (setCookie?.length) {
    http.defaults.headers.common['Cookie'] = setCookie.map(c => c.split(';')[0]).join('; ')
  }
  return res.headers['x-csrf-token']
}

// ETag (If-Match) required for PATCH/DELETE — always fetch fresh, never cache
async function fetchEtag(http, key) {
  const res = await http.get(key)
  return res.headers['etag'] || res.data?.['@odata.etag'] || '*'
}

function esc(s) { return String(s ?? '').replace(/'/g, "''") }
function json(data) { return JSON.stringify(data, null, 2) }
function sapErr(e) { throw new Error(JSON.stringify(e.response?.data ?? e.message)) }

// Strips undefined/null so partial updates only send provided fields
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null))
}

// ── Key builders ───────────────────────────────────────────────────────────

function poKey(purchaseOrderId, draftUUID, isActive) {
  return `/purchaseOrder(purchaseOrderId='${esc(purchaseOrderId)}',DraftUUID=${draftUUID},IsActiveEntity=${isActive})`
}
function itemKey(itemId, purchaseOrderId, draftUUID, isActive) {
  return `/purchaseItem(itemId='${esc(itemId)}',purchaseOrderId='${esc(purchaseOrderId)}',DraftUUID=${draftUUID},IsActiveEntity=${isActive})`
}
function tagKey(purchaseOrderId, tagId, draftUUID, isActive) {
  return `/ZZPurchaseTag(PurchaseOrderId='${esc(purchaseOrderId)}',TagId='${esc(tagId)}',DraftUUID=${draftUUID},IsActiveEntity=${isActive})`
}
function textKey(purchaseOrderId, language, draftUUID, isActive) {
  return `/purchaseOrderText(PurchaseOrderId='${esc(purchaseOrderId)}',Language='${esc(language)}',DraftUUID=${draftUUID},IsActiveEntity=${isActive})`
}

// ── Draft cycle: Edit -> mutate -> Activate (Discard on error) ────────────

// RAP bound actions on a DraftRoot (Edit/Activate/Discard) require a conditional
// (If-Match) request — the backend rejects them with
// /IWCOR/CX_OD_PRECOND_REQUIRED otherwise.
async function editPo(http, token, purchaseOrderId) {
  // A freshly-fetched GET etag is rejected as stale by Edit's precondition check
  // (SAP Note 1797736) — Edit just needs *a* conditional header, not a real
  // concurrency check, so '*' (match-any-current-representation) is used instead.
  const key = poKey(purchaseOrderId, ZERO_GUID, true)
  const res = await http.post(`${key}/${NS}.Edit`, { PreserveChanges: true }, { headers: { 'x-csrf-token': token, 'If-Match': '*' } })
    .catch(sapErr)
  return res.data // draft header: { purchaseOrderId, DraftUUID, IsActiveEntity: false, ... }
}

async function preparePo(http, token, draftPo) {
  // Required draft-cycle step (runs backend validations/determinations) between
  // the mutate step and Activate: Edit -> change -> Prepare -> Activate.
  const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
  const etag = await fetchEtag(http, key)
  const res = await http.post(`${key}/${NS}.Prepare`, {}, { headers: { 'x-csrf-token': token, 'If-Match': etag } })
    .catch(sapErr)
  return res.data
}

async function activatePo(http, token, draftPo) {
  // Always re-fetch: draftPo's embedded etag is from right after Edit — if
  // withHeaderEdit's mutate() step (PATCH/POST) changed the draft since then,
  // that embedded etag is stale and Activate rejects it.
  const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
  const etag = await fetchEtag(http, key)
  const res = await http.post(`${key}/${NS}.Activate`, {}, { headers: { 'x-csrf-token': token, 'If-Match': etag } })
    .catch(sapErr)
  return res.data // active header
}

async function discardPo(http, token, draftPo) {
  const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
  const etag = draftPo['@odata.etag'] || await fetchEtag(http, key).catch(() => '*')
  await http.post(`${key}/${NS}.Discard`, {}, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(() => {})
}

async function withHeaderEdit(http, token, purchaseOrderId, mutate) {
  const draftPo = await editPo(http, token, purchaseOrderId)
  let mutateResult
  try {
    mutateResult = await mutate(draftPo)
    await preparePo(http, token, draftPo)
  } catch (e) {
    await discardPo(http, token, draftPo)
    throw e
  }
  const activePo = await activatePo(http, token, draftPo)
  return { activePo, mutateResult }
}

// ---------------------------------------------------------------------------
module.exports = class PurchaseOrderService extends cds.ApplicationService {

  async init() {
    const {
      listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
      listPurchaseItems, getPurchaseItem, createPurchaseItem, updatePurchaseItem, deletePurchaseItem,
      listPurchaseOrderTags, createPurchaseOrderTag, deletePurchaseOrderTag, clearAllTags,
      listPurchaseOrderTexts, createPurchaseOrderText, updatePurchaseOrderText, deletePurchaseOrderText,
      listBuyers, getBuyer, listShippingMethods, getShippingMethod,
      getAllItems, getInventoryStatus, getMajorSupplier, getTagCount, calculateOpenOrderValue,
      changeStatus, checkOrder, markAsUrgent, sendToIDOC, sendOrderStatisticToAzure,
      layer1a, layer1b, layer2a, projExt
    } = this.operations

    // -----------------------------------------------------------------------
    //  READ — header
    // -----------------------------------------------------------------------

    this.on(listPurchaseOrders, async ({ data: { supplierId, buyerId, status, top, search } }) => {
      const http = httpClient()
      const filters = ['IsActiveEntity eq true']
      if (supplierId) filters.push(`supplierId eq '${esc(supplierId)}'`)
      if (buyerId) filters.push(`buyerId eq '${esc(buyerId)}'`)
      if (status) filters.push(`status eq '${esc(status)}'`)
      const params = {
        '$top': top || 50,
        '$orderby': 'purchaseOrderId',
        '$filter': filters.join(' and ')
      }
      if (search) params['$search'] = search
      const res = await http.get('/purchaseOrder', { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(getPurchaseOrder, async ({ data: { purchaseOrderId, expand } }) => {
      const http = httpClient()
      const params = {}
      if (expand) params['$expand'] = expand
      const res = await http.get(poKey(purchaseOrderId, ZERO_GUID, true), { params }).catch(sapErr)
      return json(res.data)
    })

    // -----------------------------------------------------------------------
    //  READ — items
    // -----------------------------------------------------------------------

    this.on(listPurchaseItems, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const params = { '$filter': `purchaseOrderId eq '${esc(purchaseOrderId)}' and IsActiveEntity eq true`, '$orderby': 'itemNumber' }
      const res = await http.get('/purchaseItem', { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(getPurchaseItem, async ({ data: { purchaseOrderId, itemId } }) => {
      const http = httpClient()
      const res = await http.get(itemKey(itemId, purchaseOrderId, ZERO_GUID, true)).catch(sapErr)
      return json(res.data)
    })

    // -----------------------------------------------------------------------
    //  READ — tags & texts
    // -----------------------------------------------------------------------

    this.on(listPurchaseOrderTags, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const params = { '$filter': `PurchaseOrderId eq '${esc(purchaseOrderId)}' and IsActiveEntity eq true` }
      const res = await http.get('/ZZPurchaseTag', { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(listPurchaseOrderTexts, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const params = { '$filter': `PurchaseOrderId eq '${esc(purchaseOrderId)}' and IsActiveEntity eq true` }
      const res = await http.get('/purchaseOrderText', { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    // -----------------------------------------------------------------------
    //  READ — master data (buyer / shipping method, not draft-enabled)
    // -----------------------------------------------------------------------

    this.on(listBuyers, async ({ data: { search, top } }) => {
      const http = httpClient()
      const params = { '$top': top || 50 }
      if (search) params['$filter'] = `contains(buyerId_Text,'${esc(search)}')`
      const res = await http.get('/buyer', { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(getBuyer, async ({ data: { buyerId } }) => {
      const http = httpClient()
      const res = await http.get(`/buyer(buyerId='${esc(buyerId)}')`).catch(sapErr)
      return json(res.data)
    })

    this.on(listShippingMethods, async () => {
      const http = httpClient()
      const res = await http.get('/shippingMethod').catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(getShippingMethod, async ({ data: { shippingMethod } }) => {
      const http = httpClient()
      const res = await http.get(`/shippingMethod(shippingMethod='${esc(shippingMethod)}')`).catch(sapErr)
      return json(res.data)
    })

    // -----------------------------------------------------------------------
    //  READ — bound functions (no draft handling needed for pure reads)
    // -----------------------------------------------------------------------

    this.on(getAllItems, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const key = poKey(purchaseOrderId, ZERO_GUID, true)
      const res = await http.get(`${key}/${NS}.getAllItems()`).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(getInventoryStatus, async ({ data: { purchaseOrderId, itemId } }) => {
      const http = httpClient()
      const key = itemKey(itemId, purchaseOrderId, ZERO_GUID, true)
      const res = await http.get(`${key}/${NS}.getInventoryStatus()`).catch(sapErr)
      return json(res.data)
    })

    this.on(getTagCount, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const key = poKey(purchaseOrderId, ZERO_GUID, true)
      const res = await http.get(`${key}/_tag/${NS}.getTagCount()`).catch(sapErr)
      return json(res.data)
    })

    this.on(getMajorSupplier, async ({ data: { top } }) => {
      const http = httpClient()
      const params = { '$filter': 'IsActiveEntity eq true' }
      if (top) params['$top'] = top
      const res = await http.get(`/purchaseOrder/${NS}.getMajorSupplier()`, { params }).catch(sapErr)
      return json(res.data?.value ?? res.data)
    })

    this.on(calculateOpenOrderValue, async ({ data: { supplierId } }) => {
      const http = httpClient()
      const params = { '$filter': 'IsActiveEntity eq true' }
      const res = await http.get(`/purchaseOrder/${NS}.calculateOpenOrderValue(supplierId='${esc(supplierId)}')`, { params }).catch(sapErr)
      return json(res.data)
    })

    // -----------------------------------------------------------------------
    //  WRITE — header
    // -----------------------------------------------------------------------

    this.on(createPurchaseOrder, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const body = compact({
        supplierId: data.supplierId,
        supplierName: data.supplierName,
        buyerId: data.buyerId,
        buyerName: data.buyerName,
        orderDate: data.orderDate,
        deliveryDate: data.deliveryDate,
        paymentTerms: data.paymentTerms,
        shippingMethod: data.shippingMethod,
        headerCurrency: data.headerCurrency,
        totalAmount: data.totalAmount,
        orderDescription: data.orderDescription
      })
      const draftPo = (await http.post('/purchaseOrder', body, { headers: { 'x-csrf-token': token } }).catch(sapErr)).data
      try {
        await preparePo(http, token, draftPo)
        const activePo = await activatePo(http, token, draftPo)
        return json(activePo)
      } catch (e) {
        await discardPo(http, token, draftPo)
        throw e
      }
    })

    this.on(updatePurchaseOrder, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        const body = compact({
          supplierId: data.supplierId,
          supplierName: data.supplierName,
          buyerId: data.buyerId,
          buyerName: data.buyerName,
          orderDate: data.orderDate,
          deliveryDate: data.deliveryDate,
          paymentTerms: data.paymentTerms,
          shippingMethod: data.shippingMethod,
          headerCurrency: data.headerCurrency,
          totalAmount: data.totalAmount,
          orderDescription: data.orderDescription
        })
        await http.patch(key, body, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      return json(activePo)
    })

    this.on(deletePurchaseOrder, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const key = poKey(purchaseOrderId, ZERO_GUID, true)
      const etag = await fetchEtag(http, key)
      await http.delete(key, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      return json({ result: 'Purchase order deleted successfully' })
    })

    // -----------------------------------------------------------------------
    //  WRITE — items (draft node: always via header Edit/Activate cycle)
    // -----------------------------------------------------------------------

    this.on(createPurchaseItem, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const body = compact({
          productId: data.productId,
          productName: data.productName,
          quantity: data.quantity,
          unitPrice: data.unitPrice,
          deliveryDate: data.deliveryDate,
          warehouseLocation: data.warehouseLocation,
          itemCurrency: data.itemCurrency,
          zzwarrantyperiodmonths: data.warrantyPeriodMonths
        })
        await http.post(`${key}/_items_tp`, body, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      // Items use late numbering: the draft itemId is temporary and changes on
      // Activate, so it can't be used to read the item back. Take the active item
      // with the highest itemNumber instead (the one just created).
      const params = {
        '$filter': `purchaseOrderId eq '${esc(activePo.purchaseOrderId)}' and IsActiveEntity eq true`,
        '$orderby': 'itemNumber desc',
        '$top': 1
      }
      const res = await http.get('/purchaseItem', { params }).catch(sapErr)
      return json(res.data.value?.[0] ?? { result: 'Item created' })
    })

    this.on(updatePurchaseItem, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = itemKey(data.itemId, draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        const body = compact({
          productId: data.productId,
          productName: data.productName,
          quantity: data.quantity,
          unitPrice: data.unitPrice,
          deliveryDate: data.deliveryDate,
          warehouseLocation: data.warehouseLocation,
          itemCurrency: data.itemCurrency,
          zzwarrantyperiodmonths: data.warrantyPeriodMonths
        })
        await http.patch(key, body, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      const item = await http.get(itemKey(data.itemId, activePo.purchaseOrderId, ZERO_GUID, true)).catch(sapErr)
      return json(item.data)
    })

    this.on(deletePurchaseItem, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = itemKey(data.itemId, draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        await http.delete(key, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      return json({ result: 'Purchase order item deleted successfully' })
    })

    // -----------------------------------------------------------------------
    //  WRITE — tags (draft node)
    // -----------------------------------------------------------------------

    this.on(createPurchaseOrderTag, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const body = { TagId: data.tagId, TagText: data.tagText }
        await http.post(`${key}/_tag`, body, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      const tag = await http.get(tagKey(data.purchaseOrderId, data.tagId, ZERO_GUID, true)).catch(sapErr)
      return json(tag.data)
    })

    this.on(deletePurchaseOrderTag, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = tagKey(draftPo.purchaseOrderId, data.tagId, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        await http.delete(key, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      return json({ result: 'Tag deleted successfully' })
    })

    this.on(clearAllTags, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = tagKey(draftPo.purchaseOrderId, data.tagId, draftPo.DraftUUID, false)
        await http.post(`${key}/${NS}.clearAllTags`, {}, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      return json(activePo)
    })

    // -----------------------------------------------------------------------
    //  WRITE — texts (draft node)
    // -----------------------------------------------------------------------

    this.on(createPurchaseOrderText, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        const body = { Language: data.language, TextContent: data.textContent }
        await http.post(`${key}/_text_tp`, body, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      const text = await http.get(textKey(data.purchaseOrderId, data.language, ZERO_GUID, true)).catch(sapErr)
      return json(text.data)
    })

    this.on(updatePurchaseOrderText, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = textKey(draftPo.purchaseOrderId, data.language, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        await http.patch(key, { TextContent: data.textContent }, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      const text = await http.get(textKey(data.purchaseOrderId, data.language, ZERO_GUID, true)).catch(sapErr)
      return json(text.data)
    })

    this.on(deletePurchaseOrderText, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = textKey(draftPo.purchaseOrderId, data.language, draftPo.DraftUUID, false)
        const etag = await fetchEtag(http, key)
        await http.delete(key, { headers: { 'x-csrf-token': token, 'If-Match': etag } }).catch(sapErr)
      })
      return json({ result: 'Text deleted successfully' })
    })

    // -----------------------------------------------------------------------
    //  Business actions
    // -----------------------------------------------------------------------

    // Persists a data change (status) -> goes through the draft cycle
    this.on(changeStatus, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = poKey(draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        await http.post(`${key}/${NS}.ChangeStatus`, { newStatus1: data.newStatus }, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      return json(activePo)
    })

    // Validation only, no persisted change expected -> run directly on active
    this.on(checkOrder, async ({ data: { purchaseOrderId } }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const key = poKey(purchaseOrderId, ZERO_GUID, true)
      const res = await http.post(`${key}/${NS}.checkOrder`, {}, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      return json(res.data ?? { result: 'Check completed' })
    })

    // Persists a data change (item flag) -> goes through the header draft cycle
    this.on(markAsUrgent, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const { activePo } = await withHeaderEdit(http, token, data.purchaseOrderId, async (draftPo) => {
        const key = itemKey(data.itemId, draftPo.purchaseOrderId, draftPo.DraftUUID, false)
        await http.post(`${key}/${NS}.markAsUrgent`, {}, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      })
      return json(activePo)
    })

    // Integration trigger, not a field edit -> run directly on active
    this.on(sendToIDOC, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const key = poKey(data.purchaseOrderId, ZERO_GUID, true)
      const res = await http.post(`${key}/${NS}.sendToIDOC`, { IDOC: data.idoc }, { headers: { 'x-csrf-token': token } }).catch(sapErr)
      return json(res.data ?? { result: 'Sent to IDOC' })
    })

    // Collection-bound action, scoped via $filter — verify against the real system
    this.on(sendOrderStatisticToAzure, async ({ data }) => {
      const http = httpClient()
      const token = await csrfToken(http)
      const params = { '$filter': `purchaseOrderId eq '${esc(data.purchaseOrderId)}' and IsActiveEntity eq true` }
      const res = await http.post(`/purchaseOrder/${NS}.sendOrderStatisticToAzure`,
        { serverName: data.serverName, serverAdress: data.serverAddress },
        { params, headers: { 'x-csrf-token': token } }).catch(sapErr)
      return json(res.data ?? { result: 'Statistic sent to Azure' })
    })

    // Extension hooks — unclear business semantics, called directly on active
    for (const [op, name] of [[layer1a, 'layer_1_a'], [layer1b, 'layer_1_b'], [layer2a, 'layer_2_a'], [projExt, 'proj_ext']]) {
      this.on(op, async ({ data: { purchaseOrderId } }) => {
        const http = httpClient()
        const token = await csrfToken(http)
        const key = poKey(purchaseOrderId, ZERO_GUID, true)
        const res = await http.post(`${key}/${NS}.${name}`, {}, { headers: { 'x-csrf-token': token } }).catch(sapErr)
        return json(res.data ?? { result: `${name} executed` })
      })
    }

    await super.init()
  }
}
