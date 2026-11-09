import React from 'react';
import { useWorkbenchController } from './hooks/useWorkbenchController';
import { TitlebarMenu } from './components/TitlebarMenu';
import { ActivityBar } from './components/ActivityBar';
import { LeftSidebar } from './components/LeftSidebar';
import { EditorSurface } from './components/EditorSurface';
import { BottomPanel } from './components/BottomPanel';
import { AiComposerDock } from './components/AiComposerDock';
import { WorkbenchModals } from './components/WorkbenchModals';
import { StatusBar } from './components/StatusBar';

export function App() {
  const workbenchCtx = useWorkbenchController();
  const {
    setOpenMenu,
    setShowGearPopup,
    setShowLangPopup,
    bodyGridStyle,
    centerGridStyle,
    showLeftSidebar,
    showBottomPanel,
    showRightAiDock,
    draggingSash,
    startPaneResize,
  } = workbenchCtx;

  return (
    <div
      className="ide-shell"
      onClick={() => {
        setOpenMenu(null);
        setShowGearPopup(false);
        setShowLangPopup(false);
      }}
    >
      {/* 1. Custom Native IDE Titlebar & 8-Item Project Menu Bar */}
      <TitlebarMenu ctx={workbenchCtx} />

      {/* 2. Main 4-Pane IDE Workbench Body */}
      <div className="ide-body" style={bodyGridStyle}>
        {/* Pane A: Leftmost Activity Bar (Antigravity Style) */}
        <ActivityBar ctx={workbenchCtx} />

        {/* Pane B: Primary Left Sidebar (Antigravity Explorer) */}
        <LeftSidebar ctx={workbenchCtx} />

        {/* Resizable Sash between Left Sidebar and Center Editor */}
        <div
          className={`resizer-col ${draggingSash === 'left' ? 'dragging' : ''}`}
          style={{ display: showLeftSidebar ? 'block' : 'none' }}
          title="Drag to resize Primary Sidebar"
          onMouseDown={(e) => startPaneResize('left', e)}
        />

        {/* Pane C: Center Multi-Tab Editor + Bottom Panel */}
        <main className="center-workbench" style={centerGridStyle}>
          <EditorSurface ctx={workbenchCtx} />

          {/* Resizable Horizontal Sash between Editor and Bottom Terminal Panel */}
          <div
            className={`resizer-row ${draggingSash === 'bottom' ? 'dragging' : ''}`}
            style={{ display: showBottomPanel ? 'block' : 'none' }}
            title="Drag to resize Bottom Terminal Panel"
            onMouseDown={(e) => startPaneResize('bottom', e)}
          />

          {/* Bottom Integrated Panel (Terminal / Security Audit / Runtime Output / Problems) */}
          <BottomPanel ctx={workbenchCtx} />
        </main>

        {/* Resizable Sash between Center Editor and Right AI Composer Dock */}
        <div
          className={`resizer-col ${draggingSash === 'right' ? 'dragging' : ''}`}
          style={{ display: showRightAiDock ? 'block' : 'none' }}
          title="Drag to resize Right AI Agent Dock"
          onMouseDown={(e) => startPaneResize('right', e)}
        />

        {/* Pane D: Right Docked AI Agent & Composer Panel */}
        <AiComposerDock ctx={workbenchCtx} />
      </div>

      {/* 3-5b. Modals: Project Switcher, Create File/Folder, Command Palette, Remote-SSH */}
      <WorkbenchModals ctx={workbenchCtx} />

      {/* 6. Bottom IDE Statusbar */}
      <StatusBar ctx={workbenchCtx} />
    </div>
  );
}
