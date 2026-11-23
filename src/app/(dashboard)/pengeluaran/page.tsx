'use client';

import React, { useState, useMemo } from 'react';
import useSWR from 'swr';
import { DateRange } from 'react-day-picker';
import { format } from 'date-fns';
import { PdfExportButton } from '@/components/ui/PdfExportButton';
import { PengeluaranClient } from './PengeluaranClient';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export default function PengeluaranPage() {
  const [appliedRange, setAppliedRange] = useState<DateRange>(() => {
    const today = new Date();
    return {
      from: new Date(today.getFullYear(), today.getMonth(), 1),
      to: new Date(today.getFullYear(), today.getMonth() + 1, 0),
    };
  });

  const apiUrl = useMemo(() => {
    if (appliedRange?.from) {
      const fromStr = format(appliedRange.from, 'yyyy-MM-dd');
      const toStr = format(appliedRange.to || appliedRange.from, 'yyyy-MM-dd');
      return `/api/pengeluaran?from=${fromStr}&to=${toStr}`;
    }
    return '/api/pengeluaran';
  }, [appliedRange]);

  const { data, isLoading, isValidating, mutate } = useSWR(apiUrl, fetcher, {
    keepPreviousData: true,
  });

  if (isLoading && !data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 36, height: 36, border: '4px solid #e5e7eb', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <div style={{ color: '#6b7280', fontSize: 14 }}>Memuat data pengeluaran...</div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div id="pengeluaran-report">
        <PengeluaranClient 
          initialData={data?.data || []} 
          employees={data?.employees || []}
          appliedRange={appliedRange}
          isFiltering={isValidating}
          onApplyRange={(range) => {
            if (range?.from) {
              setAppliedRange({ from: range.from, to: range.to || range.from });
            }
          }}
          onMutate={() => void mutate()}
          exportButton={<PdfExportButton targetId="pengeluaran-report" filename="laporan-pengeluaran" showCsv={false} />}
        />
      </div>
    </div>
  );
}
