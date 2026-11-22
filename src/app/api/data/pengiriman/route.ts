import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { serializeDeep } from '@/lib/serialize';

function toDateKey(d: Date | string): string {
  return new Date(d).toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  const dateFilter: any = {};
  const hasDateFilter = Boolean(startDate || endDate);
  if (hasDateFilter) {
    const startStr = startDate || endDate!;
    const endStr = endDate || startDate!;
    dateFilter.gte = new Date(startStr.includes('T') ? startStr : `${startStr}T00:00:00.000Z`);
    dateFilter.lte = new Date(endStr.includes('T') ? endStr : `${endStr}T23:59:59.999Z`);
  }

  const [
    outboundShipments,
    stockTxOut,
    personalBuyers,
    sampleDistributions,
    warehouseReturns,
    outlets,
    warehouses,
    booths,
    affiliates,
  ] = await Promise.all([
    // 1. Formal Outbound Shipments (Outlets, KOL/Affiliates, Booths, Warehouse, Online, etc.)
    prisma.outboundShipment.findMany({
      where: hasDateFilter ? { date: dateFilter } : undefined,
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      include: {
        items: { include: { product: true } },
        outlet: true,
        affiliate: true,
        employee: true,
        booth: true,
      },
    }),

    // 2. Physical Stock Movements (OUT) from Warehouses
    prisma.stockTransaction.findMany({
      where: {
        flow: 'OUT',
        ...(hasDateFilter ? { date: dateFilter } : {}),
      },
      include: {
        product: true,
        employee: true,
      },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
    }),

    // 3. Personal Buyer Direct Sales / Shipments
    prisma.personalBuyerTransaction.findMany({
      where: hasDateFilter ? { date: dateFilter } : undefined,
      include: { employee: true },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
    }),

    // 4. Sample Distributions (KOL / Affiliates / Promo)
    prisma.distribusiSample.findMany({
      where: hasDateFilter ? { date: dateFilter } : undefined,
      include: { employee: true },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
    }),

    // 5. Warehouse Returns (manual return entries from Warehouse UI + auto-logged)
    prisma.warehouseReturn.findMany({
      where: hasDateFilter ? { date: dateFilter } : undefined,
      include: {
        warehouse: true,
        items: { include: { product: true } },
      },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
    }),

    // Entity name lookups for resolving UUID source_id / destination_id on standalone StockTransactions
    prisma.outlet.findMany({ select: { id: true, nama: true } }),
    prisma.warehouse.findMany({ select: { id: true, name: true } }),
    prisma.eventBooth.findMany({ select: { id: true, nama: true } }),
    prisma.affiliate.findMany({ select: { id: true, nama: true } }),
  ]);

  const entityNameMap = new Map<string, string>();
  for (const o of outlets) entityNameMap.set(o.id, o.nama);
  for (const w of warehouses) entityNameMap.set(w.id, w.name);
  for (const b of booths) entityNameMap.set(b.id, b.nama);
  for (const a of affiliates) entityNameMap.set(a.id, a.nama);

  const unifiedShipments: any[] = [];
  const processedTxIds = new Set<string>();

  const shipmentPrefixes = new Set<string>();
  const shipmentItemSlots: Array<{
    prefix: string;
    dateKey: string;
    productId: string;
    qty: number;
    consumed: boolean;
  }> = [];
  const sampleShipmentSlots: Array<{
    dateKey: string;
    destName: string;
    totalQty: number;
    consumed: boolean;
  }> = [];
  const returShipmentSlots: Array<{
    prefix: string;
    dateKey: string;
    totalQty: number;
    consumed: boolean;
  }> = [];

  // 1. Add formal OutboundShipments
  for (const s of outboundShipments) {
    const isRetur =
      s.shipment_type === 'RETUR' ||
      s.shipment_type === 'RETURN' ||
      s.status === 'RETURNED';

    let destName = s.destination_name;
    if (!destName) {
      if (s.outlet) destName = s.outlet.nama;
      else if (s.affiliate) destName = s.affiliate.nama;
      else if (s.booth) destName = s.booth.nama;
      else destName = s.destination_type || 'Tujuan';
    }

    const shipmentType = isRetur
      ? 'RETUR'
      : s.shipment_type ||
        (s.outlet ? 'PENGIRIMAN_OUTLET' : s.booth ? 'TRANSFER_BOOTH' : 'PENGIRIMAN');

    const dateKey = toDateKey(s.date);
    const prefix = s.id.slice(0, 8);
    shipmentPrefixes.add(prefix);

    let totalQty = 0;
    for (const it of s.items) {
      totalQty += it.qty;
      shipmentItemSlots.push({
        prefix,
        dateKey,
        productId: it.product_id,
        qty: it.qty,
        consumed: false,
      });
    }

    if (shipmentType === 'SAMPLE') {
      sampleShipmentSlots.push({
        dateKey,
        destName: destName || '',
        totalQty,
        consumed: false,
      });
    }

    if (isRetur) {
      returShipmentSlots.push({
        prefix,
        dateKey,
        totalQty,
        consumed: false,
      });
    }

    unifiedShipments.push({
      id: s.id,
      date: s.date,
      created_at: s.created_at,
      shipment_type: shipmentType,
      destination_type:
        s.destination_type ||
        (s.outlet ? 'OUTLET' : s.affiliate ? 'AFFILIATE' : s.booth ? 'BOOTH' : 'GENERAL'),
      destination_name: destName,
      source_name: s.source_name || 'Gudang Pusat',
      source_type: s.source_type || 'WAREHOUSE',
      notes:
        s.notes ||
        (s.outlet
          ? `Kirim ke outlet: ${s.outlet.nama}`
          : s.booth
            ? `Transfer ke booth: ${s.booth.nama}`
            : null),
      status: s.status,
      employee: s.employee
        ? { id: s.employee.id, nama: s.employee.nama, role: s.employee.role }
        : null,
      items: s.items.map((it) => ({
        id: it.id,
        qty: it.qty,
        product: {
          id: it.product.id,
          name: it.product.name,
          short_name: it.product.short_name,
          sku: it.product.sku,
          base_price: Number(it.product.base_price || 0),
        },
      })),
    });
  }

  // 2. Add WarehouseReturn entries that aren't already represented by a formal RETUR OutboundShipment
  for (const wr of warehouseReturns) {
    const wrDate = toDateKey(wr.date);
    const totalWrQty = wr.items.reduce((sum, it) => sum + (it.qty_returned || 0), 0);

    const linkedByNotes =
      wr.notes &&
      Array.from(shipmentPrefixes).some((prefix) => wr.notes!.includes(prefix));

    let coveredByReturShipment = Boolean(linkedByNotes);
    if (!coveredByReturShipment) {
      const slot = returShipmentSlots.find(
        (sl) => !sl.consumed && sl.dateKey === wrDate && sl.totalQty === totalWrQty
      );
      if (slot) {
        slot.consumed = true;
        coveredByReturShipment = true;
      }
    }

    if (!coveredByReturShipment && wr.items.length > 0) {
      unifiedShipments.push({
        id: `WR-${wr.id}`,
        date: wr.date,
        created_at: wr.created_at,
        shipment_type: 'RETUR',
        destination_type: 'WAREHOUSE',
        destination_name: wr.warehouse?.name || 'Gudang Retur',
        source_name: wr.source_name || wr.source_type || 'Outlet/Sumber',
        source_type: wr.source_type || 'OUTLET',
        notes:
          wr.notes ||
          `Retur masuk ke ${wr.warehouse?.name || 'Gudang'}`,
        status: 'RETURNED',
        employee: null,
        items: wr.items.map((it) => ({
          id: it.id,
          qty: it.qty_returned,
          qty_reusable: it.qty_reusable,
          qty_reject: it.qty_reject,
          product: {
            id: it.product.id,
            name: it.product.name,
            short_name: it.product.short_name,
            sku: it.product.sku,
            base_price: Number(it.product.base_price || 0),
          },
        })),
      });
    }
  }

  // 3. Add Personal Buyer Transactions (linking matched stockTxOut 1-to-1 so we preserve real SKU details)
  for (const pb of personalBuyers) {
    const pbDate = toDateKey(pb.date);
    const buyerLower = (pb.buyer_name || '').trim().toLowerCase();
    const pbQty = pb.quantity || 1;

    const matchingTx = stockTxOut.find((tx) => {
      if (processedTxIds.has(tx.id)) return false;
      if (toDateKey(tx.date) !== pbDate) return false;
      if (tx.type !== 'PENJUALAN') return false;
      const desc = (tx.description || '').toLowerCase();
      return (
        desc.startsWith('personal buyer:') &&
        (!buyerLower || desc.includes(buyerLower)) &&
        tx.qty === pbQty
      );
    });

    if (matchingTx) {
      processedTxIds.add(matchingTx.id);
    }

    const srcResolved =
      matchingTx?.source_id && entityNameMap.get(matchingTx.source_id)
        ? entityNameMap.get(matchingTx.source_id)!
        : 'Gudang Calio';

    unifiedShipments.push({
      id: `PB-${pb.id}`,
      date: pb.date,
      created_at: pb.created_at,
      shipment_type: 'PERSONAL_BUYER',
      destination_type: 'ENDUSER',
      destination_name: pb.buyer_name || 'Pembeli Personal',
      source_name: srcResolved,
      source_type: 'WAREHOUSE',
      notes:
        pb.description ||
        `Pengiriman customer personal: ${pb.buyer_name} (Rp ${Number(pb.amount).toLocaleString('id-ID')})`,
      status: 'DELIVERED',
      employee: pb.employee
        ? { id: pb.employee.id, nama: pb.employee.nama, role: pb.employee.role }
        : null,
      items: [
        {
          id: `PBITEM-${pb.id}`,
          qty: pbQty,
          product: matchingTx?.product
            ? {
                id: matchingTx.product.id,
                name: matchingTx.product.name,
                short_name: matchingTx.product.short_name,
                sku: matchingTx.product.sku,
                base_price: Number(
                  pb.price_per_unit || matchingTx.product.base_price || pb.amount || 0
                ),
              }
            : {
                id: `pb-prod-${pb.id}`,
                name: pb.product_name || 'Produk CalioFish',
                short_name: pb.product_name || 'Produk CalioFish',
                sku: 'PB-DIRECT',
                base_price: Number(pb.price_per_unit || pb.amount || 0),
              },
        },
      ],
    });
  }

  // 4. Add Sample Distributions only if not already logged via an OutboundShipment (1-to-1)
  for (const sm of sampleDistributions) {
    const smDate = toDateKey(sm.date);
    const smNameLower = (sm.jenis_sample || '').toLowerCase();
    const smQty = sm.total_produk || 1;

    const matchingSlot = sampleShipmentSlots.find(
      (sl) =>
        !sl.consumed &&
        sl.dateKey === smDate &&
        (sl.totalQty === smQty ||
          (sl.destName && smNameLower.includes(sl.destName.toLowerCase())))
    );

    if (matchingSlot) {
      matchingSlot.consumed = true;
      continue;
    }

    unifiedShipments.push({
      id: `SMPL-${sm.id}`,
      date: sm.date,
      created_at: sm.created_at,
      shipment_type: 'SAMPLE',
      destination_type: 'AFFILIATE',
      destination_name: sm.jenis_sample || 'Distribusi Sample',
      source_name: 'Gudang Pusat',
      source_type: 'WAREHOUSE',
      notes: `Kirim sample promosi / endorsement (Ekspedisi: Rp ${Number(sm.biaya_ekspedisi).toLocaleString('id-ID')})`,
      status: 'SHIPPED',
      employee: sm.employee
        ? { id: sm.employee.id, nama: sm.employee.nama, role: sm.employee.role }
        : null,
      items: [
        {
          id: `SMPLITEM-${sm.id}`,
          qty: smQty,
          product: {
            id: `sample-${sm.id}`,
            name: sm.jenis_sample || 'Sample Produk Calio',
            short_name: sm.jenis_sample || 'Sample Produk Calio',
            sku: 'SAMPLE-PROMO',
            base_price: 0,
          },
        },
      ],
    });
  }

  // 5. Add standalone StockTransactions (flow: OUT) using 1-to-1 matching so same-day shipments never swallow other deliveries
  for (const tx of stockTxOut) {
    if (processedTxIds.has(tx.id)) continue;

    const txDate = toDateKey(tx.date);
    const desc = tx.description || '';

    // 5a. If description carries an explicit OutboundShipment 8-char ID prefix, treat as linked log
    const explicitPrefixMatch = Array.from(shipmentPrefixes).find((prefix) =>
      desc.includes(prefix)
    );
    if (explicitPrefixMatch) {
      const matchingSlot = shipmentItemSlots.find(
        (sl) =>
          !sl.consumed &&
          sl.prefix === explicitPrefixMatch &&
          sl.productId === tx.product_id
      );
      if (matchingSlot) matchingSlot.consumed = true;
      processedTxIds.add(tx.id);
      continue;
    }

    // 5b. Otherwise match 1-to-1 by (date + product_id + qty) against an unconsumed OutboundItem slot
    const matchedSlot = shipmentItemSlots.find(
      (sl) =>
        !sl.consumed &&
        sl.dateKey === txDate &&
        sl.productId === tx.product_id &&
        sl.qty === tx.qty
    );
    if (matchedSlot) {
      matchedSlot.consumed = true;
      processedTxIds.add(tx.id);
      continue;
    }

    processedTxIds.add(tx.id);

    const txTypeUpper = (tx.type || '').toUpperCase();
    const isRetur = txTypeUpper.includes('RETUR');
    const isBooth = txTypeUpper.includes('BOOTH');
    const isSample = txTypeUpper.includes('SAMPLE');
    const isOnline =
      txTypeUpper === 'PENJUALAN' && desc.toLowerCase().includes('online');
    const isOutlet =
      txTypeUpper.includes('OUTLET') || (tx.destination_type || '').toUpperCase() === 'OUTLET';

    const resolvedSourceName =
      (tx.source_id ? entityNameMap.get(tx.source_id) : undefined) ||
      tx.source_type ||
      'Gudang Asal';
    const resolvedDestName =
      (tx.destination_id ? entityNameMap.get(tx.destination_id) : undefined) ||
      tx.description ||
      tx.destination_type ||
      'Pengiriman Distribusi';

    const shipmentType = isRetur
      ? 'RETUR'
      : isBooth
        ? 'TRANSFER_BOOTH'
        : isSample
          ? 'SAMPLE'
          : isOnline
            ? 'ONLINE'
            : isOutlet
              ? 'PENGIRIMAN_OUTLET'
              : tx.type || 'PENGIRIMAN';

    unifiedShipments.push({
      id: `TX-${tx.id}`,
      date: tx.date,
      created_at: tx.created_at,
      shipment_type: shipmentType,
      destination_type: tx.destination_type || (isBooth ? 'BOOTH' : 'DISTRIBUSI'),
      destination_name: resolvedDestName,
      source_name: resolvedSourceName,
      source_type: tx.source_type || 'WAREHOUSE',
      notes: tx.description || `Mutasi keluar: ${tx.type}`,
      status: 'SHIPPED',
      employee: tx.employee
        ? { id: tx.employee.id, nama: tx.employee.nama, role: tx.employee.role }
        : null,
      items: [
        {
          id: `ITEM-${tx.id}`,
          qty: tx.qty,
          product: {
            id: tx.product.id,
            name: tx.product.name,
            short_name: tx.product.short_name,
            sku: tx.product.sku,
            base_price: Number(tx.product.base_price || 0),
          },
        },
      ],
    });
  }

  // Sort overall by date DESC, then created_at DESC
  unifiedShipments.sort((a, b) => {
    const diff = new Date(b.date).getTime() - new Date(a.date).getTime();
    if (diff !== 0) return diff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const totalShipments = unifiedShipments.length;
  const totalItemsSent = unifiedShipments.reduce(
    (acc, curr) => acc + curr.items.reduce((sum: number, item: any) => sum + item.qty, 0),
    0
  );

  return NextResponse.json(
    serializeDeep({
      shipments: unifiedShipments,
      totalShipments,
      totalItemsSent,
    })
  );
}
