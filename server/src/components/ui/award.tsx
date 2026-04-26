"use client"

import type React from "react"
 
import { Award, Star } from "lucide-react"

import { cn } from "@/lib/utils"

export interface AwardsComponentProps {
  variant?: "stamp" | "award" | "certificate" | "badge" | "sticker" | "id-card"
  title: string
  subtitle?: string
  description?: string
  date?: string
  recipient?: string
  level?: "bronze" | "silver" | "gold" | "platinum"
  className?: string
  showIcon?: boolean
  customIcon?: React.ReactNode
}

const levelColors = {
  bronze: "from-amber-600 to-amber-800",
  silver: "from-gray-400 to-gray-600",
  gold: "from-yellow-400 to-yellow-600",
  platinum: "from-slate-300 to-slate-500",
}

export function Awards({
  variant = "badge",
  title,
  subtitle,
  description,
  date,
  recipient,
  level = "gold",
  className,
  showIcon = true,
}: AwardsComponentProps) {
  // Stamp Variant
  if (variant === "stamp") {
    const createSerratedPath = () => {
      const radius = 96 // Half of 192px (w-48)
      const teeth = 40
      const innerRadius = radius - 8
      const outerRadius = radius

      let path = ""
      for (let i = 0; i < teeth; i++) {
        const angle = (i / teeth) * 2 * Math.PI
        const r = i % 2 === 0 ? outerRadius : innerRadius
        const x = Math.cos(angle) * r + radius
        const y = Math.sin(angle) * r + radius

        if (i === 0) {
          path += `M ${x} ${y}`
        } else {
          path += ` L ${x} ${y}`
        }
      }
      path += " Z"
      return path
    }

    // Create curved text path
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const createTextPath = (radius: number, id: string) => {
      const centerX = 96
      const centerY = 96
      return `M ${centerX - radius} ${centerY} A ${radius} ${radius} 0 0 1 ${centerX + radius} ${centerY}`
    }
    return (
      <div
        className={cn(
          "relative mx-auto flex h-48 w-48 items-center justify-center",
          className
        )}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 192 192"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Define paths for curved text */}
            <path
              id="top-curve"
              d={createTextPath(55, "top-curve")}
              fill="none"
            />
            <path
              id="bottom-curve"
              d={createTextPath(60, "bottom-curve")}
              fill="none"
              transform="rotate(180 96 96)"
            />
          </defs>

          {/* Serrated border */}
          <path
            d={createSerratedPath()}
            strokeWidth="0.2"
            className="fill-white stroke-black dark:fill-black dark:stroke-white"
          />

          {/* Inner circle */}
          <circle
            cx="96"
            cy="96"
            r="78"
            className="fill-white stroke-black dark:fill-black dark:stroke-white"
            strokeWidth="0.2"
          />

          {/* Curved text - top */}
          <text className="fill-white text-xl font-bold">
            <textPath
              href="#top-curve"
              startOffset="50%"
              textAnchor="middle"
              className="fill-black dark:fill-white"
            >
              {title}
            </textPath>
          </text>

          {/* Curved text - bottom */}
          <text className="text-[10px] tracking-wider">
            <textPath
              href="#bottom-curve"
              startOffset="50%"
              textAnchor="middle"
              className="fill-black dark:fill-white"
            >
              {subtitle}
            </textPath>
          </text>
        </svg>

        <div className="relative z-10 text-center">
          {showIcon && (
            <div className="mb-1 flex justify-center text-center text-2xl">
              {<Star className="text-primary fill-primary" />}
            </div>
          )}
          {recipient && (
            <div className="text-primary mt-2 text-[14px]">{recipient}</div>
          )}

          {date && <div className="text-[10px] italic">{date}</div>}
        </div>
      </div>
    )
  }

  // Award Variant
  if (variant === "award") {
    const LaurelWreath = () => (
      <svg
        className={cn(
          "fill-primary absolute top-1/2 h-full w-full -translate-y-1/2"
        )}
        width="892.77"
        height="688.08"
        viewBox="0 0 892.77 688.08"
      >
        <path d="M892.6,358.7c-2.45,21.69-26.03,75.09-50.59,78.41-2.61.35-8.8-.53-10.21.3-.39.23-4.32,6.79-4.75,7.74-6.88,15.27-11.04,42.49-17.43,60.57-2.66,7.51-9.87,21.35-11.03,27.98-.1.58-.26,1.65.51,1.5,6.6-6.88,8.6-17.3,13.33-25.67,13.94-24.66,43.3-43.5,72.17-42.32-2.33,14.6-10.5,29.43-19.18,41.31-12.47,17.06-30.45,32.62-53.23,29.6-7.56-1-6.85-5.3-14.59,1.58-6.35,5.64-9.71,15.53-14.19,22.81-9.91,16.12-20.19,32.01-32.8,46.2,4.66.89,8.76-7.66,11.97-11.03,11.14-11.72,21.81-19.57,38.02-22.98,15.67-3.3,37.45-3.14,52.02,4.03-12.24,25.25-57.46,51.32-84.7,41.67-7.61-2.7-12.94-10.13-22.06-6.43-18.34,18.87-38.7,35.14-61.25,48.75,4.97,1.57,9.28-3.53,13.32-5.68,20.73-11.01,32.74-14.63,56.5-9.15,13.85,3.19,26.55,9.91,38.17,17.82-19.09,21.89-75.53,31.43-97.49,11.5-3.79-3.44-5.4-10.28-10.95-11.04-9.07-1.24-22.07,6.8-31.04,10.07-3.69,1.34-27.01,9.51-28.52,7.99.06-2.6-.8-5.29,1.57-6.93,1.5-1.04,17.65-4.87,21.68-6.32,8.48-3.06,22.88-8.38,30.46-12.54,9.12-5.01,2.78-21.66,2.3-29.72-1.18-19.76,7.83-43.47,20.48-58.5,1.79-2.13,19.39-19.37,21.51-16.98-2.82,28.58.11,60.88-19.03,84.46-2.69,3.03-6.49,6.06-10.06,7.94-4.12,2.16-9.31.65-8.9,7.59,1.27,1.23,11.02-5.38,12.91-6.58,10.31-6.56,22.01-15.72,31.1-23.9,2.59-2.34,19.93-19.11,20.44-20.46.23-.63-.39-11.92-.68-13.33-1.18-5.83-6.95-13.96-8.5-21.5-3.96-19.28-2.28-43.2,4.96-61.49,3.45-8.71,9.01-17.74,15.27-24.73,2.9,17.5,8.39,36.08,10.37,53.62,1.87,16.52.69,35.79-10.9,48.86-4.62,5.21-9.96,5.2-7.97,14.52,13.17-15.31,24.53-32.58,34.16-50.33,1.99-3.66,9.61-17.17,9.7-20.13.33-10.18-12.65-21.57-17.05-30.87-11.72-24.78-14.73-58.69-5.28-84.63.71-1.96,1.42-5.12,3.44-6.04,12.22,32.23,38.76,63.84,24.79,100.27-2.31,6.03-7.68,8.74-4.76,15.73,1.54-.25,1.89-1.87,2.47-3.02,7.87-15.49,14.88-42.87,18.84-60.16,1.87-8.16,6.12-21.11,2.85-28.5-4.29-9.69-11.33-11.15-18.64-17.35-24.62-20.88-33.84-58.75-31.52-89.97,1.97-.51,1.93.81,2.81,1.68,20.75,20.47,53.85,55.45,49.12,86.75-.44,2.9-3.52,7.02-3.71,9.23s2.82,4.83,2.79,7.33c1.42,1.39,1.82-.07,1.99-1.48.8-6.86,1.5-14.15,1.99-21.03,1.05-14.96,1.76-33.12,1.05-48.03-.45-9.51-.5-18.45-7.5-25.5-4.23-4.26-9.74-3.95-14.91-6.09-28.89-12.01-48.06-49.12-49.88-79.13-.07-1.11-2.03-1.97.73-1.73,23.64,16.34,59.89,35.61,63.41,67.59.81,7.39-3.03,17.42,5.1,20.39-.84-15.5-4.12-31.76-7.48-47.01-1.91-8.66-8.25-37.76-12.65-43.35-6.39-8.12-14.14-3.87-22.25-4.75-21.82-2.37-43.12-23.21-53.78-41.22-3.02-5.1-7.72-13-7.34-18.66,29.71,10.05,66.39,12.92,75.07,48.93,1.39,5.76-1.51,11.75,7.44,11.05-9.45-25.34-21.53-49.48-34.15-73.34-9.49-11.1-18.29-1.46-29.31-.62-24.24,1.85-49.97-15.79-62.53-35.54,12.16-1.78,27.18-2.45,39.53-1.53,14.47,1.07,29.13,6.2,36.65,19.35,3.12,5.45,2.93,14.34,10.8,11.68-7.94-13.11-17.24-26.37-27.04-38.45-2.54-3.14-13.54-16.92-15.98-18.02-7.78-3.53-11.89,2.2-17.3,4.66-22.22,10.12-48.27,3.4-65.69-12.67-1.12-1.03-7.02-6.35-5.98-7.51,17.62-2.11,36.48-11.68,54.24-7.75,8.57,1.89,16.8,6.91,22.19,13.81,2.88,3.69.83,6.42,7.06,6.94,1.49.12,2.92.63,2.49-1.49-8.92-8.7-17.38-18.05-26.98-26.03-3.66-3.04-13.47-11.25-17.29-12.71-4.55-1.73-10.25-.33-15.11-.89-27.28-3.12-48.71-29.1-57.58-53.4,1.55-2.18,1.45-.91,2.6-.65,29.66,6.66,68.48,16.71,70.87,53.16,21.14,14.84,39.62,33.01,57,52,.62-8.81-9.38-14.38-14.48-20.52-19.56-23.59-25.5-58.58-24.02-88.47.68-.79,10.44,7.02,11.52,7.97,20.16,17.57,37.02,49.29,34.52,76.57-1,10.9-9.52,15.89-4.29,28.21,1.81,4.26,14.83,18.08,18.66,23.34,9.6,13.17,19.55,27.31,26.6,41.91,1.62.09,2.24.49,1.98-1.47-.48-3.57-9.92-18.62-12.17-23.85-11.51-26.81-14.45-60.89-2.88-88.23.37-.88.81-2.87,2.06-1.96,9.94,12.98,16.87,28.86,21.49,44.52,5.8,19.65,9.83,40.98.04,60.03-1.45,2.82-4.93,5.59-5.48,8.51-2.09,11.08,6.07,21.31,10.12,30.78,7.21,16.81,14.1,33.95,18.83,51.67,1.58-.05,1.97-4.44,1.92-5.42-.27-5.28-7.25-19.63-8.64-27.37-4.67-26.05-2.53-50.65,10.53-73.88,1.45-2.57,4.8-8.51,6.73-10.28,1.69-1.54,1.69-.41,2.66,1.23,12.28,20.79,17.41,81.23,2.78,101.21-2.35,3.21-9.25,7.51-10.45,9.55-.39.66-3.05,12.36-3.11,13.43-.35,5.98,7.73,33.4,9.25,42.34,2.02,11.93,3.48,24.11,4.32,36.18,2.19-.58,1.95-2.71,2.05-4.46.4-6.52-1.93-15.33-2.11-22-.88-33.13,13.53-64.28,38.54-85.52,1.65-.03,3.41,14.23,3.55,16.43,1.54,24.35-4.14,74.1-26.52,88.57-6.99,4.52-12.38,3.46-14.29,13.71-2.29,12.31,3.05,32.46.81,45.81l-4.03,40.46c4.58-3.93,3.21-12.03,4.24-17.25,6.58-33.49,28.21-64.47,60.75-76.75-.37,4.65.51,9.94,0,14.5Z" />
        <path d="M122.6,347.7c-1.7,17.7-14.14,47.55-26.48,60.52-5.79,6.09-14.83,9.27-20.05,15.95-7.2,9.23-5.11,14.49-3.18,25.23,4.49,25.1,12.63,50.47,22.72,73.79,1.68-.31,2.16-5.36,2.02-6.44-.24-1.76-4.97-6.9-6.22-9.86-8.94-21.17-.97-44.77,8.01-64.37l18.18-35.83c12.17,28.27,10.36,66.34-4.83,93.18-4.82,8.52-16.69,18.39-14.52,29.1.83,4.09,6.01,13.72,8.18,17.9,9.33,17.95,21.89,36.15,35.16,51.33,1.78-8.72-2.17-7.86-6.5-12.99-25.68-30.41-7.81-69.51-2-104.01,20.14,23.8,27.35,62.58,18.27,92.26-3.14,10.27-9.76,17.88-6.25,29.71,18.74,19.75,39.22,38.23,63.47,51.02.89-8.43-5.47-6.33-10.34-9.15-4.61-2.67-12.11-11.32-15.06-15.94-13.97-21.88-9.34-50.93-13.57-75.43,4.11-.29,10.26,4.82,13.45,7.55,18.34,15.69,31.07,45.29,29.51,69.46-.49,7.59-5.43,18.51-.47,25.5,1.35,1.9,21.37,10.31,25.22,11.78,9.94,3.8,20.08,6.73,30.28,9.72l.98,7.51c-7.54-2.18-15.1-4.36-22.51-6.98-7.88-2.79-24.11-11.27-30.95-12.04-11.89-1.35-11.52,5.99-19.05,12-20.85,16.65-61.75,9.86-83.5-2.46-2.07-1.18-13.19-7.73-11.54-10.53,21.13-14.47,48.69-24.76,74.34-17.26,10.95,3.2,20.18,11.91,29.19,14.81,1.02.33,5.04,1.53,5.02-.51-11.82-6.39-24.42-14.2-34.91-22.59-6.02-4.82-23.27-23.82-27.5-25.5-9.8-3.9-9.91.63-16.9,4.26-26.89,13.94-71.69-11.42-87.08-34.28-1.05-1.55-3.6-3.96-2.17-5.96,3.81-5.34,36.79-5.58,43.94-4.81,18.64,1.99,33.72,11.44,46.14,24.86,3.15,3.4,6.26,11.64,11.48,10.52-10.1-11.12-19.65-23.71-27.41-36.58-5-8.3-11.58-25.16-17.59-31.41-7.79-8.1-10.21-3.34-18.5-2.52-24.7,2.44-44.75-17.93-56.91-37.07-6.3-9.93-12.8-22.08-13.59-33.92,33.98-.41,60.36,19.86,75.52,48.98,3.34,6.42,4.42,14.83,10.47,19.02-6.28-16.37-13.32-32.34-18.26-49.23s-6.28-33.8-14.89-48.61c-33.08,1.59-49.47-37.67-57.35-64.16-2.91-9.81-5.26-18.73-3.5-28.99,26.83,9.2,52.19,40.65,58.53,67.96,1.93,8.33.98,19.55,6.46,26.03-5.71-27.36-4-55.47-3.25-83.24-.33-2.46-2.64-10.16-4.27-11.73-1.84-1.78-8.46-3.44-11.41-5.59-21.82-15.94-28.32-68.11-24.94-92.82.26-1.88,2.02-11.61,3.38-11.6,24.77,21.31,40.05,54.58,38.49,87.47-.37,7.9-3.74,17.25-1.49,24.51,1.87-1.18,1.21-2.88,1.51-4.49,2.56-13.9,3.69-28.54,6.31-42.69,1.26-6.78,7.5-26.71,7.24-31.33-.05-.87-2.77-11.88-3.12-12.42-.93-1.43-6.38-5.09-8.41-7.59-17.02-20.94-12.69-82.05.77-104.18.86-1.41,1.09-3.01,2.65-1.25,3.37,3.78,8.96,15.02,11.03,19.97,8.44,20.2,10.18,39.73,6.24,61.21-1.57,8.58-8.23,23.74-8.7,30.39-.09,1.31.19,5.98,1.96,6.38,2.2-9.93,5.59-20.68,9.26-30.24,4.82-12.57,15.43-28.92,18.49-40.51.76-2.89,1.78-9.95,1.23-12.72-.47-2.38-6.17-8.59-7.75-12.24-9.36-21.65.56-56.02,9.6-76.95.98-2.26,12.81-26.07,15.16-24.32,12.15,28.6,10.64,62.39-1.81,90.67-2.46,5.58-10.57,17.48-11.2,21.81-.14.96-.63,3.81,1.01,3.51,4.3-10.16,10.59-19.63,16.79-28.71,6.7-9.82,24.02-28.29,27.92-37.08,5.11-11.53.33-12.38-2.74-21.66-7.05-21.37,8.26-54.53,22.07-71.01,3.38-4.04,17.33-17.9,21.49-19.52,1.73-.68,1.35.43,1.49,1.47,3.89,29.17-8.37,67.53-27.03,89.99-4.6,5.54-11.32,8.61-11.97,16.52,1.97.46,2.37-1.01,3.41-2.08,16.97-17.57,33.36-36.17,54.38-49.11-.07-35.38,43.89-46.99,71.78-53.74,1.38-.33,1.84.04,1.42,1.42-5.53,18.05-25.93,42.44-43.72,49.28-12.29,4.72-24.31,2.03-34.57,8.43-14.24,8.89-27.32,24.04-38.69,36.31,6.82,2.69,8.09-6.05,11.95-10.05,18.99-19.63,50.96-6.74,73.53-2.45,1.16.29.47,1.31.03,2.01-2.75,4.35-16.7,13.95-21.64,16.36-13.41,6.54-31.14,9.11-45.24,3.5-7.37-2.94-11.36-9.47-20.93-6.66-4.55,1.34-25.58,28.93-29.52,34.48-3.29,4.64-12.58,17.34-14.17,21.83-1,2.82,5.58-.56,6-1,.9-.94,3.53-9.1,5.75-12.25,5.76-8.16,20.75-17.27,30.73-17.27h43l1.06,2.03c-13.36,19.94-41.02,38.11-65.81,34.71-10.24-1.41-16.8-10.17-26.17,1.35-8.68,10.66-28.7,55.97-32.13,69.87-.26,1.06-1.13,3.41.04,4.04,6.8-3.28,4.54-9.25,5.94-15.06,7.5-31,50.07-37.7,75.55-45.94-6.63,24.9-36.5,58.71-63.45,60.04-7.64.37-14.17-2.72-20.55,4.45-2.66,2.99-6.55,17.32-7.91,22.09-3.07,10.75-5.58,22.38-7.6,33.4-2.1,11.43-4.64,23.48-3.98,35.02,6.42-4.26,3.24-5.92,3.5-10.5,2.2-39.31,32.77-57.91,63.47-76.54.76-.46,1.75-1.99,2.53-.47-3.3,29.92-22.05,68.78-51.31,80.69-4.12,1.68-8.25,1.66-12.01,3.99-1.75,1.09-6.98,6.87-7.46,8.54-1.18,4.12-2.01,16.84-2.25,21.75-1.13,22.55,1.18,45.14,3.05,67.54,1.37,1.8,4.44-5.33,4.55-5.94.14-.79-4.39-11.57-4.45-15.45-.46-30.71,29.69-61.31,49.92-82.09.96-.98,1.3-1.88,2.98-1.52-.55,7.91.75,16.71,0,24.5Z" />
      </svg>
    )
    return (
      <div
        className={cn(
          "relative z-0",
          "flex flex-col items-center justify-center p-6",
          "overflow-hidden",
          className
        )}
      >
        <LaurelWreath />
        <div className="z-10 px-8 text-center">
          <div
            className={cn(
              "mt-6 mb-2 inline-block rounded-md px-4 py-1 tracking-wider text-white",
              `bg-gradient-to-r ${levelColors[level]}`
            )}
          >
            {level.toUpperCase()}
          </div>

          {/* Main Title — each word on its own line, long words shrink */}
          <h1 className={cn(
            "font-black tracking-tight leading-[0.95]",
            title.replace(/\s/g, '').length > 9 ? "text-2xl" : "text-4xl",
          )}>
            {title.trim().split(/\s+/).map((word, i) => (
              <span key={i} className="block">{word}</span>
            ))}
          </h1>

          {/* Decorative Line */}
          <div className="bg-primary mx-auto my-3 h-[1px] w-40"></div>

          {/* Subtitle */}
          <h2 className={cn("mb-4 w-60 text-xl font-light")}>{subtitle}</h2>

          {/* Recipient */}
          {recipient && (
            <p className={cn("text-primary/60 italic")}>{recipient}</p>
          )}

          {/* Date */}
          <div className={cn("text-xl font-bold")}>{date}</div>
        </div>
      </div>
    )
  }

  if (variant === "certificate") {
    const Badge = () => (
      <svg
        className={cn("fill-primary -mt-12 h-18 w-full overflow-hidden")}
        width="24"
        height="24"
        viewBox="0 0 24 24"
      >
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
      </svg>
    )
    return (
      <div
        className={cn(
          "relative z-0",
          "flex flex-col items-center justify-center rounded-xl border-2 border-dotted p-2",
          "overflow-hidden",
          className
        )}
      >
        <div className="bg-card z-10 rounded-sm border p-6 px-8 text-center">
          <Badge />
          <h1
            className={cn(
              "mt-4 grid text-3xl leading-7 font-bold tracking-tighter uppercase"
            )}
          >
            Certificate
            <span className="text-sm font-light tracking-tight">
              {" "}
              of {title}
            </span>
          </h1>

          <p className="text-muted-foreground mt-4 mb-1 text-xs">
            This is to certify that
          </p>
          <h1
            className={cn(
              "text-primary mb-2 border-b text-xl font-semibold tracking-tight"
            )}
          >
            {recipient}
          </h1>

          <p className="text-muted-foreground mb-1 text-xs">{subtitle}</p>
          <div className="mt-6 flex justify-center">
            <Award strokeWidth={1} className="h-4 w-4" />
          </div>
          <div className={cn("mt-2 text-xs")}>Awarded on: {date}</div>
        </div>
      </div>
    )
  }

  if (variant === "badge") {
    const Badge = () => (
      <svg
        className={cn("fill-primary h-full w-18 overflow-hidden")}
        width="500.15"
        height="620.78"
        viewBox="0 0 500.15 620.78"
      >
        <path d="M453.85,385.1c16.99-26.81,1.62-58.47,18.76-87.24,12.03-20.19,29.82-36.18,27.29-62.46-2.84-29.52-33.04-48.63-35.87-75.13-2.33-21.77,2.23-43.54-9.49-63.51-17.52-29.86-57.27-24.53-79.03-47.97-14.71-15.84-24.1-37.76-46.27-45.73-31.05-11.17-56.45,12.73-85.44,9.44-22.25-2.52-42.24-16.43-65.98-11.43-26.93,5.68-36.44,28.9-52.83,47.17-18.28,20.39-48.97,19.08-69.44,36.56-23.39,19.97-16.36,46.88-19.55,73.45-3.37,28.13-28.95,43.88-34.69,70.31-8.97,41.31,30.51,58.13,34.69,93.72,2.55,21.68-2.27,42.21,9.85,62.15,13.67,22.49,41.07,24.3,62.09,35.93l-65.92,141.39,90.99-30,33.5,89,71.4-151.37c7.8-2.36,16.43-2.29,24.22-.03l69.89,151.41,35-89.01,90.98,30-65.92-141.4c20.6-11.4,47.98-13.54,61.74-35.28ZM431.43,373.69c-11.35,14.21-47.72,18.54-65.33,32.67-14.18,11.38-31.96,45.62-48.03,48.97-17.04,3.56-45.93-12.02-65.51-12.59-22.09-.65-52.83,16.31-70.6,12.59-14.66-3.06-30.11-30.64-40.43-41.57-19.15-20.28-38.59-19.72-60.89-31.11-25.19-12.87-17.89-36.67-19.64-60.36-2.27-30.87-18.47-40.83-31.16-64.84-16.91-32.01,19.44-52.21,27.88-81.45,5.54-19.2-.16-53.87,9.85-68.15,10.07-14.38,49.06-19.97,66.35-33.65,14.41-11.4,32.04-46.32,48.82-49.18,17.2-2.93,45.07,12.06,64.72,12.8,22.27.84,51.14-15.97,69.81-12.8,16.61,2.82,34.57,37.73,48.82,49.18,17.13,13.76,56.34,19.33,66.35,33.65,9.88,14.14,4.2,50.54,10.53,70.47,6.78,21.37,34.53,44.15,31.92,65.86-2.24,18.62-27.45,39.98-33.17,61.83-4.94,18.87.75,53.84-10.31,67.69Z" />
        <path d="M238.82,68.07C104.43,76.3,30.99,231.31,110.21,341.1c68.96,95.57,211.43,95.17,280.04-.59,84.76-118.31-7.09-281.26-151.43-272.43ZM374.44,319.7c-57.48,90.24-188.7,90.73-247.83,2-61.13-91.74-.65-219.62,109.21-228.61,122.55-10.03,205.2,122.08,138.62,226.62Z" />
        <path d="M259.84,157.96c8.2,18.06,16.68,44.63,40.38,45.97,0,0,27.28,3.19,27.28,3.19,9.06,1.06,12.7,12.26,5.99,18.45-14.64,13.38-37.29,29.66-31.24,52.61,0,0,5.39,26.93,5.39,26.93,1.79,8.94-7.74,15.87-15.69,11.4-17.24-9.79-39.73-26.3-59.69-13.45,0,0-23.94,13.45-23.94,13.45-7.95,4.47-17.48-2.46-15.69-11.4,3.98-19.43,12.74-45.91-5.65-60.92,0,0-20.19-18.61-20.19-18.61-6.71-6.18-3.07-17.39,5.99-18.45,19.71-2.21,47.6-2.07,56.19-24.2,0,0,11.46-24.96,11.46-24.96,3.81-8.29,15.59-8.29,19.39,0Z" />
      </svg>
    )
    return (
      <div className={cn("", className)}>
        <div
          className={cn("rounded-md border-4 p-4", "flex justify-start gap-3")}
        >
          <Badge />
          <div className={cn("border-l px-3")}>
            <h1
              className={cn("text-primary text-4xl font-bold tracking-tight")}
            >
              {title}
            </h1>
            <h2 className={cn("text-muted-foreground text-md font-light")}>
              {subtitle}
            </h2>

            <div className="mt-1 flex items-center gap-4 text-xs">
              {recipient && <p className={cn("italic")}>by {recipient}</p>}•
              <div className={cn("")}>{date}</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Sticker Variant
  if (variant === "sticker") {
    return (
      <div
        className={cn(
          "relative inline-flex -rotate-5 transform items-center justify-center",
          className
        )}
      >
        <div className="relative text-center">
          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              transform: "translate(10px, 10px)",
              WebkitTextStroke: "10px white",
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              transform: "translate(10px, 10px)",
              WebkitTextStroke: "10px black",
            }}
          >
            {title}
          </span>

          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              transform: "translate(8px, 8px)",
              WebkitTextStroke: "10px white",
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              transform: "translate(8px, 8px)",
              WebkitTextStroke: "10px black",
            }}
          >
            {title}
          </span>

          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              transform: "translate(6px, 6px)",
              WebkitTextStroke: "10px white",
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              transform: "translate(6px, 6px)",
              WebkitTextStroke: "10px black",
            }}
          >
            {title}
          </span>

          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              transform: "translate(4px, 4px)",
              WebkitTextStroke: "10px white",
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              transform: "translate(4px, 4px)",
              WebkitTextStroke: "10px black",
            }}
          >
            {title}
          </span>

          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              transform: "translate(2px, 2px)",
              WebkitTextStroke: "10px white",
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              transform: "translate(2px, 2px)",
              WebkitTextStroke: "10px black",
            }}
          >
            {title}
          </span>

          <span
            className="absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              WebkitTextStroke: "10px white",
              textShadow: `
                -1px -1px 0 white,
                1px -1px 0 white,
                -1px 1px 0 white,
                1px 1px 0 white,
                -1px 0 0 white,
                1px 0 0 white,
                0 -1px 0 white,
                0 1px 0 white
              `,
            }}
          >
            {title}
          </span>

          <span
            className="absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              WebkitTextStroke: "10px black",
              textShadow: `
                -1px -1px 0 black,
                1px -1px 0 black,
                -1px 1px 0 black,
                1px 1px 0 black,
                -1px 0 0 black,
                1px 0 0 black,
                0 -1px 0 black,
                0 1px 0 black
              `,
            }}
          >
            {title}
          </span>

          <span
            className="text-primary absolute hidden text-7xl font-black tracking-tighter dark:block"
            style={{
              WebkitTextStroke: "0px black",
              textShadow: `
                -2px -2px 0 white,
                2px -2px 0 white,
                -2px 2px 0 white,
                2px 2px 0 white,
                -2px 0 0 white,
                2px 0 0 white,
                0 -2px 0 white,
                0 2px 0 white
              `,
            }}
          >
            {title}
          </span>

          <span
            className="text-primary absolute block text-7xl font-black tracking-tighter dark:hidden"
            style={{
              WebkitTextStroke: "0px white",
              textShadow: `
                -2px -2px 0 white,
                2px -2px 0 white,
                -2px 2px 0 white,
                2px 2px 0 white,
                -2px 0 0 white,
                2px 0 0 white,
                0 -2px 0 white,
                0 2px 0 white
              `,
            }}
          >
            {title}
          </span>

          <span
            className="text-primary relative text-7xl font-black tracking-tighter"
            style={{
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            {title}
          </span>
        </div>
      </div>
    )
  }

  if (variant === "id-card") {
    return (
      <div className={cn("flex bg-card items-center rounded-md border shadow-lg p-1 justify-center", className)}>
        <div className="relative h-100 w-72 rounded-sm overflow-hidden border-4">
          
          <span className="absolute top-8 right-8 flex h-4 w-4  items-center  justify-center">
            <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"></span>
            <span className="bg-primary relative inline-flex h-3 w-3 rounded-full"></span>
          </span>

          <div className="mt-24 px-6">
            <div
              className={cn(
                "bg-secondary mb-4 w-fit rounded-md border px-4 py-2 text-xs"
              )}
            >
              {date}
            </div>
            <h1 className="text-5xl leading-tight font-bold">{title}</h1> 
            <p className="text-muted-foreground -mt-2 text-md font-light tracking-wider">
              {subtitle}
            </p>
          </div>
          <div className="absolute bottom-6 w-full border-t">
            <div className="mt-6 flex justify-between px-6">
              <div>
                <div className="text-xs">VIRTUAL</div>
                <div className="text-primary text-lg font-semibold">
                  {description}
                </div>
              </div>
              <div className="p-3"> 
                <svg
                width="24"
                height="24"
                viewBox="0 0 392.02 324.6"
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg" >
                 <path
                                fill="#fff200"
                                d="M268.08,0c-27.4,0-51.41,4.43-72.07,13.26C175.36,4.43,151.35,0,123.95,0H0v324.6h123.95c27.37,0,51.38-4.58,72.07-13.7,20.69,9.12,44.7,13.7,72.07,13.7h123.95V0h-123.95ZM324.09,268.36h-47.91c-20.25,0-37.3-4.05-51.18-12.15-12.28-7.17-21.94-17.41-28.99-30.7h0s0,0,0,0c0,0,0,0,0,0h0c-7.05,13.29-16.71,23.53-28.99,30.7-13.87,8.1-30.93,12.15-51.18,12.15h-47.91V56.24h47.91c19.8,0,36.67,4.01,50.61,12.04,12.51,7.2,22.35,17.47,29.55,30.77h0s0,0,0,0c0,0,0,0,0,0h0c7.2-13.3,17.04-23.57,29.55-30.77,13.95-8.02,30.82-12.04,50.61-12.04h47.91v212.13Z"
                            />
            </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Default fallback
  return null
}
