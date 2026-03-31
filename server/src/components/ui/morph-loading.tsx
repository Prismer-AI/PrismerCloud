"use client"

import { cn } from "@/lib/utils"

interface UniqueLoadingProps {
  variant?: "morph"
  size?: "sm" | "md" | "lg"
  className?: string
}

// Define keyframes as CSS-in-JS for reliability
const morphKeyframes = `
@keyframes morph-0 {
  0%, 100% { transform: translate(0, 0) scale(1); border-radius: 0%; }
  25% { transform: translate(20px, -20px) scale(1.2); border-radius: 50%; }
  50% { transform: translate(40px, 0) scale(0.8); border-radius: 25%; }
  75% { transform: translate(20px, 20px) scale(1.1); border-radius: 75%; }
}
@keyframes morph-1 {
  0%, 100% { transform: translate(0, 0) scale(1) rotate(0deg); border-radius: 0%; }
  25% { transform: translate(-20px, -20px) scale(1.3) rotate(90deg); border-radius: 50%; }
  50% { transform: translate(-40px, 0) scale(0.7) rotate(180deg); border-radius: 25%; }
  75% { transform: translate(-20px, 20px) scale(1.2) rotate(270deg); border-radius: 75%; }
}
@keyframes morph-2 {
  0%, 100% { transform: translate(0, 0) scale(1); border-radius: 0%; }
  25% { transform: translate(-20px, 20px) scale(0.9); border-radius: 100%; }
  50% { transform: translate(0, 40px) scale(1.4); border-radius: 0%; }
  75% { transform: translate(20px, 20px) scale(0.8); border-radius: 50%; }
}
@keyframes morph-3 {
  0%, 100% { transform: translate(0, 0) scale(1) rotate(0deg); border-radius: 0%; }
  25% { transform: translate(20px, 20px) scale(1.1) rotate(-90deg); border-radius: 25%; }
  50% { transform: translate(0, -40px) scale(1.3) rotate(-180deg); border-radius: 100%; }
  75% { transform: translate(-20px, -20px) scale(0.9) rotate(-270deg); border-radius: 75%; }
}
`;

export default function UniqueLoading({
  variant = "morph",
  size = "md",
  className,
}: UniqueLoadingProps) {
  const containerSizes = {
    sm: "w-16 h-16",
    md: "w-24 h-24",
    lg: "w-32 h-32",
  }

  const colors = [
    "bg-violet-500",
    "bg-cyan-500", 
    "bg-emerald-500",
    "bg-amber-500"
  ]

  if (variant === "morph") {
    return (
      <>
        <style>{morphKeyframes}</style>
        <div className={cn("relative", containerSizes[size], className)}>
          <div className="absolute inset-0 flex items-center justify-center">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={cn("absolute w-4 h-4 shadow-lg", colors[i])}
                style={{
                  animation: `morph-${i} 2s infinite ease-in-out`,
                  animationDelay: `${i * 0.2}s`,
                }}
              />
            ))}
          </div>
        </div>
      </>
    )
  }

  return null
}