import { createPortal } from 'react-dom';

// Нижнее окно (подтверждение, детали). Рендерится прямо в body: внутри экрана вкладки оно оказывалось
// под нижним меню (у .app-main свой слой), и меню закрывало кнопки окна.
export default function Sheet({ onClose, children, className = '' }) {
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet w-full max-w-sm rounded-2xl p-5 ${className}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
