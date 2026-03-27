'use client';

import { useEffect, useRef } from 'react';
import { SiriOrb } from '@/components/ui/siri-orb';

const MOCK_TASKS = [
  { type: 'deposit', label: 'Storing arxiv_2301.pdf' },
  { type: 'deposit', label: 'Indexing Q3_Report.docx' },
  { type: 'deposit', label: 'Parsing Nvidia_10K.html' },
  { type: 'withdraw', label: 'Reading context #8f2a' },
  { type: 'withdraw', label: 'Fetching cached embedding' },
  { type: 'withdraw', label: 'Querying vector DB' },
  { type: 'deposit', label: 'Analyzing chart_01.png' },
];

interface HeroGlobeProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function HeroGlobe({ containerRef }: HeroGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      mouseRef.current = { x, y };
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('mousemove', handleMouseMove);
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove);
      }
    };
  }, [containerRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;

    // Config - will be updated dynamically based on canvas size
    const AGENT_COUNT = 80;
    const FOV = 800;
    
    // Function to get responsive globe size
    const getGlobeRadius = () => {
      const minDim = Math.min(canvas.width || 600, canvas.height || 500);
      return Math.max(150, Math.min(280, minDim * 0.38));
    };
    
    const getCoreRadius = () => {
      const minDim = Math.min(canvas.width || 600, canvas.height || 500);
      return Math.max(30, Math.min(60, minDim * 0.08));
    };

    // State
    let autoRotationY = 0;
    let smoothMouseX = 0;
    let smoothMouseY = 0;

    interface Agent3D {
      id: number;
      phi: number;
      theta: number;
      currentFlash: number;
      currentDim: number;
      bubble?: {
        text: string;
        life: number;
        type: 'deposit' | 'withdraw';
      };
    }

    interface Packet {
      id: number;
      agentId: number;
      type: 'deposit' | 'withdraw';
      progress: number;
      speed: number;
    }

    interface Spark {
      x: number; y: number; z: number;
      vx: number; vy: number; vz: number;
      life: number;
      color: string;
    }

    // Initialize Agents (Fibonacci Sphere)
    const agents: Agent3D[] = [];
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < AGENT_COUNT; i++) {
      const y = 1 - (i / (AGENT_COUNT - 1)) * 2;
      const radius = Math.sqrt(1 - y * y);
      const theta = phi * i;
      agents.push({
        id: i,
        phi: Math.acos(y),
        theta: theta,
        currentFlash: 0,
        currentDim: 0
      });
    }

    let packets: Packet[] = [];
    let sparks: Spark[] = [];
    let packetIdCounter = 0;

    const getAgentBasePos = (agent: Agent3D, r: number) => {
      const y = Math.cos(agent.phi) * r;
      const rad = Math.sin(agent.phi) * r;
      const x = Math.cos(agent.theta) * rad;
      const z = Math.sin(agent.theta) * rad;
      return { x, y, z };
    };

    const rotate3D = (x: number, y: number, z: number, angleX: number, angleY: number) => {
      const cosX = Math.cos(angleX);
      const sinX = Math.sin(angleX);
      const y1 = y * cosX - z * sinX;
      const z1 = y * sinX + z * cosX;
      const x1 = x;

      const cosY = Math.cos(angleY);
      const sinY = Math.sin(angleY);
      const x2 = x1 * cosY - z1 * sinY;
      const z2 = x1 * sinY + z1 * cosY;
      const y2 = y1;

      return { x: x2, y: y2, z: z2 };
    };

    const render = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        // Responsive height based on parent's actual height
        canvas.height = parent.clientHeight || 700;
      }
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      autoRotationY += 0.0015;
      const targetMouseX = mouseRef.current.x * 0.3;
      const targetMouseY = mouseRef.current.y * 0.3;
      smoothMouseX += (targetMouseX - smoothMouseX) * 0.05;
      smoothMouseY += (targetMouseY - smoothMouseY) * 0.05;

      const rotX = -smoothMouseY;
      const rotY = autoRotationY + smoothMouseX;

      // Spawn tasks
      if (Math.random() < 0.03) {
        const idleAgents = agents.filter(a => !a.bubble);
        if (idleAgents.length > 0) {
          const agent = idleAgents[Math.floor(Math.random() * idleAgents.length)];
          const task = MOCK_TASKS[Math.floor(Math.random() * MOCK_TASKS.length)];

          packets.push({
            id: packetIdCounter++,
            agentId: agent.id,
            type: task.type as 'deposit' | 'withdraw',
            progress: 0,
            speed: 0.01 + Math.random() * 0.01
          });

          if (task.type === 'deposit') {
            agent.currentFlash = 1.0;
          } else {
            agent.currentDim = 1.0;
          }

          agent.bubble = {
            text: task.label,
            type: task.type as 'deposit' | 'withdraw',
            life: 1.0
          };
        }
      }

      interface RenderItem {
        z: number;
        draw: () => void;
      }
      const renderList: RenderItem[] = [];
      const agentScreenPositions = new Map<number, { x: number; y: number; z: number; scale: number }>();

      // Process Agents
      agents.forEach(agent => {
        agent.currentFlash *= 0.95;
        agent.currentDim *= 0.95;
        if (agent.bubble) {
          agent.bubble.life -= 0.005;
          if (agent.bubble.life <= 0) agent.bubble = undefined;
        }

        const base = getAgentBasePos(agent, getGlobeRadius());
        const pos = rotate3D(base.x, base.y, base.z, rotX, rotY);
        const scale = FOV / (FOV + pos.z);

        agentScreenPositions.set(agent.id, { x: pos.x, y: pos.y, z: pos.z, scale });

        renderList.push({
          z: pos.z,
          draw: () => {
            const x2d = cx + pos.x * scale;
            const y2d = cy + pos.y * scale;
            const r = 3 * scale;

            let rG = 113, gG = 113, bG = 122;
            let alpha = 0.5;

            if (agent.currentFlash > 0.01) {
              const f = agent.currentFlash;
              rG = rG * (1 - f) + 6 * f;
              gG = gG * (1 - f) + 182 * f;
              bG = bG * (1 - f) + 212 * f;
              alpha = 0.5 + 0.5 * f;
            } else if (agent.currentDim > 0.01) {
              const d = agent.currentDim;
              rG = rG * (1 - d) + 20 * d;
              gG = gG * (1 - d) + 20 * d;
              bG = bG * (1 - d) + 30 * d;
              alpha = 0.5 - 0.2 * d;
            }

            ctx.beginPath();
            ctx.arc(x2d, y2d, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${Math.floor(rG)}, ${Math.floor(gG)}, ${Math.floor(bG)}, ${alpha})`;
            ctx.fill();

            if (agent.bubble && agent.bubble.life > 0) {
              const b = agent.bubble;
              const zFade = Math.max(0, Math.min(1, (pos.z + 200) / 300));
              const opacity = Math.min(b.life, zFade) * 0.9;

              if (opacity > 0.05) {
                ctx.font = `${Math.max(10, 12 * scale)}px "JetBrains Mono", monospace`;
                ctx.textAlign = 'left';

                const tx = x2d + 15 * scale;
                const ty = y2d + 4 * scale;

                const metrics = ctx.measureText(b.text);
                const pad = 6 * scale;
                const bw = metrics.width + pad * 2;
                const bh = 20 * scale;

                ctx.fillStyle = b.type === 'deposit'
                  ? `rgba(6, 182, 212, ${opacity * 0.15})`
                  : `rgba(124, 58, 237, ${opacity * 0.15})`;
                ctx.strokeStyle = b.type === 'deposit'
                  ? `rgba(6, 182, 212, ${opacity * 0.4})`
                  : `rgba(124, 58, 237, ${opacity * 0.4})`;

                ctx.beginPath();
                ctx.roundRect(tx, ty - bh / 1.5, bw, bh, 4 * scale);
                ctx.fill();
                ctx.lineWidth = 1 * scale;
                ctx.stroke();

                ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
                ctx.fillText(b.text, tx + pad, ty + bh / 4 - bh / 1.5 + 2 * scale);
              }
            }
          }
        });
      });

      // Process Packets
      packets = packets.filter(p => p.progress < 1);
      packets.forEach(pkt => {
        pkt.progress += pkt.speed;

        const agentPos = agentScreenPositions.get(pkt.agentId);
        if (!agentPos) return;

        const startX = pkt.type === 'deposit' ? agentPos.x : 0;
        const startY = pkt.type === 'deposit' ? agentPos.y : 0;
        const startZ = pkt.type === 'deposit' ? agentPos.z : 0;

        const endX = pkt.type === 'deposit' ? 0 : agentPos.x;
        const endY = pkt.type === 'deposit' ? 0 : agentPos.y;
        const endZ = pkt.type === 'deposit' ? 0 : agentPos.z;

        const currX = startX + (endX - startX) * pkt.progress;
        const currY = startY + (endY - startY) * pkt.progress;
        const currZ = startZ + (endZ - startZ) * pkt.progress;

        renderList.push({
          z: currZ,
          draw: () => {
            const pktScale = FOV / (FOV + currZ);
            const x2d = cx + currX * pktScale;
            const y2d = cy + currY * pktScale;

            const color = pkt.type === 'deposit' ? '#06b6d4' : '#c084fc';

            ctx.shadowBlur = 10 * pktScale;
            ctx.shadowColor = color;
            ctx.beginPath();
            ctx.arc(x2d, y2d, 3 * pktScale, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.shadowBlur = 0;

            const tailLen = 0.15;
            if (pkt.progress > tailLen) {
              const tailX = startX + (endX - startX) * (pkt.progress - tailLen);
              const tailY = startY + (endY - startY) * (pkt.progress - tailLen);
              const tailZ = startZ + (endZ - startZ) * (pkt.progress - tailLen);
              const tailScale = FOV / (FOV + tailZ);
              const tx2d = cx + tailX * tailScale;
              const ty2d = cy + tailY * tailScale;

              const grad = ctx.createLinearGradient(x2d, y2d, tx2d, ty2d);
              grad.addColorStop(0, color);
              grad.addColorStop(1, 'transparent');

              ctx.beginPath();
              ctx.moveTo(x2d, y2d);
              ctx.lineTo(tx2d, ty2d);
              ctx.strokeStyle = grad;
              ctx.lineWidth = 2 * pktScale;
              ctx.stroke();
            }
          }
        });

        if (pkt.progress >= 1) {
          if (pkt.type === 'deposit') {
            for (let k = 0; k < 5; k++) {
              sparks.push({
                x: 0, y: 0, z: 0,
                vx: (Math.random() - 0.5) * 5,
                vy: (Math.random() - 0.5) * 5,
                vz: (Math.random() - 0.5) * 5,
                life: 1.0,
                color: '#06b6d4'
              });
            }
          } else {
            const agent = agents[pkt.agentId];
            if (agent) {
              agent.currentFlash = 1.0;
              agent.currentDim = 0;
            }
          }
        }
      });

      // Process Sparks
      sparks = sparks.filter(s => s.life > 0);
      sparks.forEach(s => {
        s.x += s.vx;
        s.y += s.vy;
        s.z += s.vz;
        s.life -= 0.05;

        renderList.push({
          z: s.z,
          draw: () => {
            const sparkScale = FOV / (FOV + s.z);
            const x2d = cx + s.x * sparkScale;
            const y2d = cy + s.y * sparkScale;
            ctx.fillStyle = s.color;
            ctx.globalAlpha = s.life;
            ctx.fillRect(x2d, y2d, 2 * sparkScale, 2 * sparkScale);
            ctx.globalAlpha = 1;
          }
        });
      });

      // Add Core glow effect (logo is rendered as overlay)
      renderList.push({
        z: 0,
        draw: () => {
          const coreScale = FOV / (FOV + 0);
          const pulse = 1 + Math.sin(Date.now() / 800) * 0.05;
          const r = getCoreRadius() * coreScale * pulse;

          const grad = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.5);
          grad.addColorStop(0, 'rgba(124, 58, 237, 0.6)');
          grad.addColorStop(0.4, 'rgba(6, 182, 212, 0.2)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');

          ctx.beginPath();
          ctx.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        }
      });

      renderList.sort((a, b) => a.z - b.z);
      renderList.forEach(item => item.draw());

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  return (
    <div className="relative w-full lg:flex-1 flex items-center justify-center pointer-events-none h-[350px] sm:h-[420px] md:h-[520px] lg:h-[600px] xl:h-[700px]">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] sm:w-[400px] md:w-[600px] lg:w-[800px] h-[300px] sm:h-[400px] md:h-[600px] lg:h-[800px] bg-violet-600/5 blur-[60px] sm:blur-[80px] md:blur-[120px] rounded-full"></div>
      <canvas
        ref={canvasRef}
        className="w-full h-full relative z-10"
      />
      {/* Centered SiriOrb Animation */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
        <div className="relative">
          {/* Outer glow */}
          <div className="absolute inset-0 -m-6 md:-m-8 rounded-full bg-gradient-to-r from-violet-600/30 to-cyan-500/30 blur-2xl md:blur-3xl animate-pulse" style={{ animationDuration: '4s' }}></div>
          {/* SiriOrb */}
          <SiriOrb 
            size="80px"
            animationDuration={15}
            colors={{
              c1: 'oklch(65% 0.28 280)', // Bright violet
              c2: 'oklch(72% 0.22 200)', // Cyan
              c3: 'oklch(60% 0.25 300)', // Deep purple
            }}
            className="w-16 h-16 sm:w-20 sm:h-20 md:w-24 md:h-24 lg:w-28 lg:h-28 drop-shadow-[0_0_30px_rgba(124,58,237,0.6)] md:drop-shadow-[0_0_50px_rgba(124,58,237,0.7)]"
      />
        </div>
      </div>
    </div>
  );
}

