import type React from 'react';
import { useState } from 'react';

export type ResizeSashKind = 'left' | 'right' | 'bottom' | 'settings';

export function usePaneLayout() {
  const [showLeftSidebar, setShowLeftSidebar] = useState(false);
  const [showBottomPanel, setShowBottomPanel] = useState(false);
  const [showRightAiDock, setShowRightAiDock] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(240);
  const [rightAiDockWidth, setRightAiDockWidth] = useState<number>(390);
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(180);
  const [settingsNavWidth, setSettingsNavWidth] = useState<number>(220);
  const [draggingSash, setDraggingSash] = useState<null | ResizeSashKind>(null);

  function startPaneResize(sash: ResizeSashKind, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraggingSash(sash);
    const startX = e.clientX;
    const startY = e.clientY;
    const initLeft = leftSidebarWidth;
    const initRight = rightAiDockWidth;
    const initBottom = bottomPanelHeight;
    const initSettings = settingsNavWidth;

    const onMouseMove = (moveEv: MouseEvent) => {
      if (sash === 'left') {
        const next = Math.max(160, Math.min(600, initLeft + (moveEv.clientX - startX)));
        setLeftSidebarWidth(next);
      } else if (sash === 'right') {
        const next = Math.max(280, Math.min(760, initRight - (moveEv.clientX - startX)));
        setRightAiDockWidth(next);
      } else if (sash === 'bottom') {
        const next = Math.max(110, Math.min(560, initBottom - (moveEv.clientY - startY)));
        setBottomPanelHeight(next);
      } else if (sash === 'settings') {
        const next = Math.max(170, Math.min(420, initSettings + (moveEv.clientX - startX)));
        setSettingsNavWidth(next);
      }
    };

    const onMouseUp = () => {
      setDraggingSash(null);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    document.body.style.cursor = sash === 'bottom' ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  const bodyGridStyle: React.CSSProperties = {
    gridTemplateColumns: [
      '46px',
      showLeftSidebar ? `minmax(180px, min(${leftSidebarWidth}px, 28vw)) 5px` : '',
      'minmax(0, 1fr)',
      showRightAiDock ? `5px minmax(260px, min(${rightAiDockWidth}px, 42vw))` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };

  const centerGridStyle: React.CSSProperties = {
    gridTemplateRows: showBottomPanel
      ? `minmax(0, 1fr) 5px ${bottomPanelHeight}px`
      : 'minmax(0, 1fr)',
  };

  return {
    showLeftSidebar,
    setShowLeftSidebar,
    showBottomPanel,
    setShowBottomPanel,
    showRightAiDock,
    setShowRightAiDock,
    leftSidebarWidth,
    setLeftSidebarWidth,
    rightAiDockWidth,
    setRightAiDockWidth,
    bottomPanelHeight,
    setBottomPanelHeight,
    settingsNavWidth,
    setSettingsNavWidth,
    draggingSash,
    startPaneResize,
    bodyGridStyle,
    centerGridStyle,
  };
}

