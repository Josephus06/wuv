import { createPortal } from 'react-dom';

// Rendered through a portal to <body>, NOT inline where it is written in the tree. A modal is
// a fixed overlay meant to cover the viewport, but `position: fixed` is measured against the
// nearest ancestor that has a transform, filter or backdrop-filter -- not the viewport -- and
// the card-glass wallpaper treatment puts a backdrop-filter on every .card. A picker opened
// from inside a card would otherwise be trapped and clipped to that card's box. The portal
// lifts it out so it always covers the screen, whatever it was opened from.
//
// `large` is the common wide modal (820px); `xl` (1140px) is for forms carrying a
// full line-item grid, where 820px leaves most columns behind a horizontal scroll.
export default function Modal({ title, onClose, children, large, xl }) {
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${xl ? 'modal-xl' : large ? 'modal-lg' : ''}`}>
        <div className="page-header">
          <h2>{title}</h2>
          <button className="btn btn-sm" onClick={onClose} type="button">Close</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
