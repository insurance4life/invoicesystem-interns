import { Routes, Route, Navigate } from 'react-router-dom';
import AdjustmentList from './AdjustmentList.jsx';
import AdjustmentForm from './AdjustmentForm.jsx';
import PriceLists from './PriceLists.jsx';
import PriceListForm from './PriceListForm.jsx';
import StockCard from './StockCard.jsx';

/** Mounted at /inventory/*: stock adjustments, price lists and stock cards. */
export default function InventoryRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="adjustments" replace />} />
      <Route path="adjustments" element={<AdjustmentList />} />
      <Route path="adjustments/new" element={<AdjustmentForm />} />
      <Route path="adjustments/:id" element={<AdjustmentForm />} />
      <Route path="adjustments/:id/edit" element={<AdjustmentForm />} />
      <Route path="price-lists" element={<PriceLists />} />
      <Route path="price-lists/new" element={<PriceListForm />} />
      <Route path="price-lists/:id" element={<PriceListForm />} />
      <Route path="price-lists/:id/edit" element={<PriceListForm />} />
      <Route path="stock/:itemId" element={<StockCard />} />
      <Route path="*" element={<Navigate to="adjustments" replace />} />
    </Routes>
  );
}
