import { useEffect, useRef, useState } from 'react';

export interface ProjectInfo {
  hash: string;
  name: string;
  agentCount: number;
}

interface ProjectPickerProps {
  projects: ProjectInfo[];
  selectedHash: string | null;
  onSelect: (hash: string | null) => void;
}

export function ProjectPicker({ projects, selectedHash, onSelect }: ProjectPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  if (projects.length === 0) return null;

  const selectedProject = projects.find((p) => p.hash === selectedHash);
  const buttonLabel = selectedProject ? selectedProject.name : 'All Projects';
  const totalAgents = projects.reduce((sum, p) => sum + p.agentCount, 0);

  return (
    <div ref={pickerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen((v) => !v)}
        style={{
          padding: '4px 10px',
          fontSize: '22px',
          color: 'var(--pixel-text)',
          background: isOpen ? 'var(--pixel-active-bg)' : 'var(--pixel-btn-bg)',
          border: isOpen ? '2px solid var(--pixel-accent)' : '2px solid transparent',
          borderRadius: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap',
          maxWidth: 160,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title="Select project to view"
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: selectedHash ? 'var(--pixel-accent)' : 'var(--pixel-green)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {buttonLabel}
        </span>
        <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
          {selectedHash ? selectedProject?.agentCount ?? 0 : totalAgents}
        </span>
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 4,
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            boxShadow: 'var(--pixel-shadow)',
            minWidth: 200,
            maxWidth: 280,
            zIndex: 'var(--pixel-controls-z)',
            maxHeight: 300,
            overflowY: 'auto',
          }}
        >
          {/* "All Projects" option */}
          <button
            onClick={() => {
              onSelect(null);
              setIsOpen(false);
            }}
            onMouseEnter={() => setHovered('__all__')}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              fontSize: '22px',
              color: 'var(--pixel-text)',
              background:
                selectedHash === null
                  ? 'var(--pixel-active-bg)'
                  : hovered === '__all__'
                    ? 'var(--pixel-btn-hover-bg)'
                    : 'transparent',
              border: selectedHash === null ? '2px solid var(--pixel-accent)' : '2px solid transparent',
              borderRadius: 0,
              cursor: 'pointer',
              textAlign: 'left',
              gap: 8,
            }}
          >
            <span>All Projects</span>
            <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
              {totalAgents}
            </span>
          </button>

          {/* Divider */}
          <div
            style={{
              height: 1,
              background: 'var(--pixel-border)',
              margin: '2px 0',
            }}
          />

          {/* Per-project options */}
          {projects.map((project) => (
            <button
              key={project.hash}
              onClick={() => {
                onSelect(project.hash);
                setIsOpen(false);
              }}
              onMouseEnter={() => setHovered(project.hash)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                fontSize: '22px',
                color: 'var(--pixel-text)',
                background:
                  selectedHash === project.hash
                    ? 'var(--pixel-active-bg)'
                    : hovered === project.hash
                      ? 'var(--pixel-btn-hover-bg)'
                      : 'transparent',
                border:
                  selectedHash === project.hash
                    ? '2px solid var(--pixel-accent)'
                    : '2px solid transparent',
                borderRadius: 0,
                cursor: 'pointer',
                textAlign: 'left',
                gap: 8,
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {project.name}
              </span>
              <span style={{ fontSize: '18px', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
                {project.agentCount}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
