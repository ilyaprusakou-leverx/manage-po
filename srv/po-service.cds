/**
 * Purchase Order Service – wraps SAP OData V4 service ZPRU_PURCORDERHDR_ODATA.
 * The @mcp annotation causes @cap-js/mcp to expose it as an MCP server.
 * With per_action_tool=true each action/function becomes its own MCP tool.
 *
 * The underlying service is draft-enabled (RAP). This wrapper always deals in
 * ACTIVE instances only: reads filter to IsActiveEntity=true, and every write
 * tool internally drives the required Edit → change → Activate draft cycle
 * (discarding the draft on failure) so callers never see draft concepts.
 */

@mcp
@mcp.instructions: 'Manage SAP Purchase Orders. All tools operate on ACTIVE purchase order data only — draft handling is internal. Tools: listPurchaseOrders/getPurchaseOrder (key: purchaseOrderId), createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, listPurchaseItems/getPurchaseItem/createPurchaseItem/updatePurchaseItem/deletePurchaseItem (key: purchaseOrderId+itemId), listPurchaseOrderTags/createPurchaseOrderTag/deletePurchaseOrderTag/clearAllTags, listPurchaseOrderTexts/createPurchaseOrderText/updatePurchaseOrderText/deletePurchaseOrderText, listBuyers/getBuyer, listShippingMethods/getShippingMethod, changeStatus, checkOrder, markAsUrgent, sendToIDOC, sendOrderStatisticToAzure, getAllItems, getInventoryStatus, getMajorSupplier, getTagCount, calculateOpenOrderValue, layer1a/layer1b/layer2a/projExt (custom extension hooks).'

service PurchaseOrderService {

  // Entities kept for schema reference only — never used as DB tables.
  @readonly
  entity PurchaseOrders {
    key purchaseOrderId : String(20);
        orderDate        : Date;
        supplierId       : String(10);
        supplierName     : String(50);
        buyerId          : String(10);
        buyerName        : String(50);
        totalAmount      : Decimal(15,2);
        headerCurrency   : String(5);
        deliveryDate     : Date;
        status           : String(1);
        paymentTerms     : String(1);
        shippingMethod   : String(1);
        orderDescription : String(5000);
  }

  @readonly
  entity PurchaseItems {
    key itemId            : String(20);
    key purchaseOrderId   : String(20);
        productId         : String(10);
        productName       : String(50);
        quantity          : Integer;
        unitPrice         : Decimal(15,2);
        totalPrice        : Decimal(15,2);
        deliveryDate      : Date;
        warehouseLocation : String(20);
        itemCurrency      : String(5);
        warrantyPeriodMonths : Integer;
  }

  // ---------------------------------------------------------------------
  //  Read functions
  // ---------------------------------------------------------------------

  @Common.Label: 'List Purchase Orders'
  function listPurchaseOrders(
    supplierId : String(10),
    buyerId    : String(10),
    status     : String(1),
    top        : Integer,
    search     : String
  ) returns String;

  @Common.Label: 'Get Purchase Order'
  function getPurchaseOrder(
    purchaseOrderId : String(20),
    expand          : String
  ) returns String;

  @Common.Label: 'List Purchase Order Items'
  function listPurchaseItems(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'Get Purchase Order Item'
  function getPurchaseItem(
    purchaseOrderId : String(20),
    itemId          : String(20)
  ) returns String;

  @Common.Label: 'List Purchase Order Tags'
  function listPurchaseOrderTags(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'List Purchase Order Texts'
  function listPurchaseOrderTexts(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'List Buyers'
  function listBuyers(
    search : String,
    top    : Integer
  ) returns String;

  @Common.Label: 'Get Buyer'
  function getBuyer(
    buyerId : String(10)
  ) returns String;

  @Common.Label: 'List Shipping Methods'
  function listShippingMethods() returns String;

  @Common.Label: 'Get Shipping Method'
  function getShippingMethod(
    shippingMethod : String(1)
  ) returns String;

  @Common.Label: 'Get All Items (bound function)'
  function getAllItems(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'Get Inventory Status For Item (bound function)'
  function getInventoryStatus(
    purchaseOrderId : String(20),
    itemId          : String(20)
  ) returns String;

  @Common.Label: 'Get Major Supplier (bound function, active orders)'
  function getMajorSupplier(
    top : Integer
  ) returns String;

  @Common.Label: 'Get Tag Count For Order (bound function)'
  function getTagCount(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'Calculate Open Order Value For Supplier (bound function)'
  function calculateOpenOrderValue(
    supplierId : String(10)
  ) returns String;

  // ---------------------------------------------------------------------
  //  Write actions — header
  // ---------------------------------------------------------------------

  @Common.Label: 'Create Purchase Order'
  action createPurchaseOrder(
    supplierId       : String(10),
    supplierName     : String(50),
    buyerId          : String(10),
    buyerName        : String(50),
    orderDate        : Date,
    deliveryDate     : Date,
    paymentTerms     : String(1),
    shippingMethod   : String(1),
    headerCurrency   : String(5),
    totalAmount      : Decimal(15,2),
    orderDescription : String(5000)
  ) returns String;

  @Common.Label: 'Update Purchase Order'
  action updatePurchaseOrder(
    purchaseOrderId  : String(20),
    supplierId       : String(10),
    supplierName     : String(50),
    buyerId          : String(10),
    buyerName        : String(50),
    orderDate        : Date,
    deliveryDate     : Date,
    paymentTerms     : String(1),
    shippingMethod   : String(1),
    headerCurrency   : String(5),
    totalAmount      : Decimal(15,2),
    orderDescription : String(5000)
  ) returns String;

  @Common.Label: 'Delete Purchase Order'
  action deletePurchaseOrder(
    purchaseOrderId : String(20)
  ) returns String;

  // ---------------------------------------------------------------------
  //  Write actions — items
  // ---------------------------------------------------------------------

  @Common.Label: 'Create Purchase Order Item'
  action createPurchaseItem(
    purchaseOrderId      : String(20),
    productId            : String(10),
    productName          : String(50),
    quantity             : Integer,
    unitPrice            : Decimal(15,2),
    deliveryDate         : Date,
    warehouseLocation    : String(20),
    itemCurrency         : String(5),
    warrantyPeriodMonths : Integer
  ) returns String;

  @Common.Label: 'Update Purchase Order Item'
  action updatePurchaseItem(
    purchaseOrderId      : String(20),
    itemId               : String(20),
    productId            : String(10),
    productName          : String(50),
    quantity             : Integer,
    unitPrice            : Decimal(15,2),
    deliveryDate         : Date,
    warehouseLocation    : String(20),
    itemCurrency         : String(5),
    warrantyPeriodMonths : Integer
  ) returns String;

  @Common.Label: 'Delete Purchase Order Item'
  action deletePurchaseItem(
    purchaseOrderId : String(20),
    itemId          : String(20)
  ) returns String;

  // ---------------------------------------------------------------------
  //  Write actions — tags & texts
  // ---------------------------------------------------------------------

  @Common.Label: 'Create Purchase Order Tag'
  action createPurchaseOrderTag(
    purchaseOrderId : String(20),
    tagId           : String(20),
    tagText         : String(40)
  ) returns String;

  @Common.Label: 'Delete Purchase Order Tag'
  action deletePurchaseOrderTag(
    purchaseOrderId : String(20),
    tagId           : String(20)
  ) returns String;

  @Common.Label: 'Clear All Tags (bound action)'
  action clearAllTags(
    purchaseOrderId : String(20),
    tagId           : String(20)
  ) returns String;

  @Common.Label: 'Create Purchase Order Text'
  action createPurchaseOrderText(
    purchaseOrderId : String(20),
    language        : String(2),
    textContent     : String(5000)
  ) returns String;

  @Common.Label: 'Update Purchase Order Text'
  action updatePurchaseOrderText(
    purchaseOrderId : String(20),
    language        : String(2),
    textContent     : String(5000)
  ) returns String;

  @Common.Label: 'Delete Purchase Order Text'
  action deletePurchaseOrderText(
    purchaseOrderId : String(20),
    language        : String(2)
  ) returns String;

  // ---------------------------------------------------------------------
  //  Business actions (bound, OData V4 FunctionImport-style operations)
  // ---------------------------------------------------------------------

  @Common.Label: 'Change Purchase Order Status'
  action changeStatus(
    purchaseOrderId : String(20),
    newStatus       : String(1)
  ) returns String;

  @Common.Label: 'Check Purchase Order'
  action checkOrder(
    purchaseOrderId : String(20)
  ) returns String;

  @Common.Label: 'Mark Item As Urgent'
  action markAsUrgent(
    purchaseOrderId : String(20),
    itemId          : String(20)
  ) returns String;

  @Common.Label: 'Send Purchase Order To IDOC'
  action sendToIDOC(
    purchaseOrderId : String(20),
    idoc            : String(20)
  ) returns String;

  @Common.Label: 'Send Order Statistic To Azure'
  action sendOrderStatisticToAzure(
    purchaseOrderId : String(20),
    serverName      : String(40),
    serverAddress   : String(11)
  ) returns String;

  // Custom extension hooks present in the service (exact business behaviour
  // depends on the customer/partner implementation behind them).
  @Common.Label: 'Layer 1a Extension Hook'
  action layer1a(purchaseOrderId : String(20)) returns String;

  @Common.Label: 'Layer 1b Extension Hook'
  action layer1b(purchaseOrderId : String(20)) returns String;

  @Common.Label: 'Layer 2a Extension Hook'
  action layer2a(purchaseOrderId : String(20)) returns String;

  @Common.Label: 'Project Extension Hook'
  action projExt(purchaseOrderId : String(20)) returns String;
}
