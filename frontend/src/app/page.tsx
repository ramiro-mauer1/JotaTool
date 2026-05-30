"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, useMotionValue, useSpring, useMotionTemplate, AnimatePresence } from "motion/react";
import {
  Upload,
  Image as ImageIcon,
  Trash2,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  X,
  Share,
} from "lucide-react";

/* ────── Types ────── */

interface ProcessedFile {
  name: string;
  original: string;
  processed: string;
}

interface BatchState {
  status: "idle" | "uploading" | "queued" | "processing" | "completed" | "failed";
  current: number;
  total: number;
  message: string;
  files: ProcessedFile[];
}

/* ────── Constants ────── */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || ""; 
const MAX_FILES = 25;
const ACCEPTED = ["image/png", "image/jpeg", "image/jpg"];

/* ────── Animation Variants ────── */

const staggerList = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const staggerItem = {
  hidden: { opacity: 0, y: 8, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring", stiffness: 400, damping: 30 },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } }
};

const fadeTransition = {
  hidden: { opacity: 0, filter: "blur(4px)" },
  show: { opacity: 1, filter: "blur(0px)", transition: { duration: 0.4 } },
  exit: { opacity: 0, filter: "blur(4px)", transition: { duration: 0.3 } }
};

/* ────── Page ────── */

export default function Home() {
  /* state */
  const [files, setFiles] = useState<File[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [batch, setBatch] = useState<BatchState>({
    status: "idle",
    current: 0,
    total: 0,
    message: "",
    files: [],
  });
  
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  /* Spring Physics for the image comparator */
  const rawSliderPos = useMotionValue(50);
  const springSliderPos = useSpring(rawSliderPos, { stiffness: 500, damping: 40 });
  const clipPathAfter = useMotionTemplate`inset(0 calc(100% - ${springSliderPos}%) 0 0)`;
  const handleLeft = useMotionTemplate`${springSliderPos}%`;

  /* cleanup SSE on unmount */
  useEffect(() => () => { sseRef.current?.close(); }, []);

  /* Reset slider to center when image changes */
  useEffect(() => {
    rawSliderPos.set(50);
  }, [selectedIdx, rawSliderPos]);

  /* ─── File handling ─── */

  const addFiles = useCallback((incoming: File[]) => {
    const images = incoming.filter((f) => ACCEPTED.includes(f.type));
    if (!images.length) return;
    setFiles((prev) => [...prev, ...images].slice(0, MAX_FILES));
  }, []);

  const onDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(e.type === "dragenter" || e.type === "dragover");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  const removeFile = (i: number) => setFiles((p) => p.filter((_, idx) => idx !== i));

  const reset = () => {
    sseRef.current?.close();
    sseRef.current = null;
    setFiles([]);
    setBatchId(null);
    setBatch({ status: "idle", current: 0, total: 0, message: "", files: [] });
    setSelectedIdx(0);
    rawSliderPos.set(50);
  };

  /* ─── Upload + SSE ─── */

  const startProcessing = async () => {
    if (!files.length) return;
    setBatch((p) => ({ ...p, status: "uploading", message: "Subiendo al servidor…", total: files.length }));

    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    
    // Render Free Tier Cold-Start Indicator (tardará ~50s la primera vez)
    const wakeUpTimer = setTimeout(() => setIsWakingUp(true), 3000);

    try {
      const res = await fetch(`${BACKEND}/api/upload`, { method: "POST", body: form });
      clearTimeout(wakeUpTimer);
      setIsWakingUp(false);
      
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Error de red." }));
        throw new Error(err.detail ?? "Error al subir.");
      }
      const { batch_id } = await res.json();
      setBatchId(batch_id);

      /* connect SSE */
      sseRef.current?.close();
      const source = new EventSource(`${BACKEND}/api/progress/${batch_id}`);
      sseRef.current = source;

      source.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          setBatch({
            status: d.status,
            current: d.current,
            total: d.total,
            message: d.message,
            files: d.files ?? [],
          });
          if (d.status === "completed" || d.status === "failed") source.close();
        } catch { /* ignore parse errors */ }
      };
      source.onerror = () => {
        source.close();
      };
    } catch (err: any) {
      clearTimeout(wakeUpTimer);
      setIsWakingUp(false);
      setBatch((p) => ({ ...p, status: "failed", message: err.message ?? "Error inesperado." }));
    }
  };

  /* ─── Share Native API ─── */

  const shareImages = async () => {
    if (batch.status !== "completed" || !batch.files.length) return;
    
    setIsSharing(true);
    
    try {
      const filesToShare = await Promise.all(
        batch.files.map(async (f) => {
          // Usamos ruta absoluta si la URL es relativa para que funcione en iOS
          const url = f.processed.startsWith("http") ? f.processed : `${window.location.origin}${f.processed}`;
          const res = await fetch(url);
          const blob = await res.blob();
          const cleanName = f.name.replace(/\.[^/.]+$/, "") + "_clean.jpg";
          return new File([blob], cleanName, { type: blob.type });
        })
      );

      // Mobile first: iOS Safari Web Share API for Files
      if (navigator.canShare && navigator.canShare({ files: filesToShare })) {
        await navigator.share({
          files: filesToShare,
          title: "Imágenes procesadas con JotaTool",
        });
      } else {
        // Fallback for desktop: download multiple files
        filesToShare.forEach((file) => {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      }
    } catch (error) {
      console.error("Error al compartir", error);
    } finally {
      setIsSharing(false);
    }
  };

  /* ─── Comparator Drag Logic ─── */

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sliderRef.current || e.buttons !== 1) return;
    const rect = sliderRef.current.getBoundingClientRect();
    let percent = ((e.clientX - rect.left) / rect.width) * 100;
    percent = Math.max(0, Math.min(100, percent));
    rawSliderPos.set(percent);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sliderRef.current) return;
    sliderRef.current.setPointerCapture(e.pointerId);
    const rect = sliderRef.current.getBoundingClientRect();
    let percent = ((e.clientX - rect.left) / rect.width) * 100;
    percent = Math.max(0, Math.min(100, percent));
    rawSliderPos.set(percent);
  };

  /* ─── Gallery nav ─── */
  const prev = () => setSelectedIdx((i) => Math.max(0, i - 1));
  const next = () => setSelectedIdx((i) => Math.min(batch.files.length - 1, i + 1));

  const pct = batch.total ? Math.round((batch.current / batch.total) * 100) : 0;
  const active = batch.files[selectedIdx];

  /* ────── Render ────── */
  return (
    <div className="flex flex-col min-h-[100dvh] max-w-[1280px] mx-auto px-5 sm:px-8 py-10 selection:bg-gold-500/30 selection:text-gold-200">

      {/* ── Header ── */}
      <header className="mb-10 sm:mb-14 pt-4">
        <h1 className="text-2xl sm:text-3xl font-medium tracking-tight">
          Jota<span className="text-gold-500">Tool</span>
        </h1>
      </header>

      {/* ── Main grid ── */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-start">

        {/* ─ Left panel ─ */}
        <section className="lg:col-span-5 flex flex-col gap-6">
          <AnimatePresence mode="popLayout">
            
            {/* IDLE STATE: DROP ZONE & FILE LIST */}
            {batch.status === "idle" && (
              <motion.div
                key="idle"
                variants={fadeTransition}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex flex-col gap-6"
              >
                {/* Drop zone */}
                <motion.div
                  role="button"
                  tabIndex={0}
                  onDragEnter={onDrag}
                  onDragOver={onDrag}
                  onDragLeave={onDrag}
                  onDrop={onDrop}
                  onClick={() => inputRef.current?.click()}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  className={`
                    relative flex flex-col items-center justify-center gap-4
                    rounded-2xl border p-12 text-center
                    cursor-pointer transition-colors duration-300
                    ${dragOver
                      ? "border-gold-500 bg-gold-500/[.03]"
                      : "border-dark-800 bg-[#111] hover:border-dark-700"
                    }
                  `}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept=".png,.jpg,.jpeg"
                    onChange={onFileInput}
                    className="hidden"
                  />
                  <div className="w-12 h-12 rounded-full bg-dark-900 border border-dark-800 flex items-center justify-center shadow-sm">
                    <Upload className="w-4 h-4 text-zinc-400" />
                  </div>
                  <div>
                    <p className="text-[13px] font-medium text-zinc-200">
                      Arrastra tus fotos
                    </p>
                    <p className="text-[11px] text-zinc-500 mt-1">
                      JPG / PNG (Max {MAX_FILES})
                    </p>
                  </div>
                </motion.div>

                {/* File list (staggered) */}
                {files.length > 0 && (
                  <motion.div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[12px] font-medium text-zinc-400">
                        {files.length} archivos seleccionados
                      </span>
                      <button onClick={reset} className="text-[12px] text-zinc-500 hover:text-red-400 transition-colors">
                        Limpiar
                      </button>
                    </div>

                    <motion.ul 
                      variants={staggerList} 
                      initial="hidden" 
                      animate="show"
                      className="max-h-[320px] overflow-y-auto space-y-1.5 pr-1 custom-scrollbar"
                    >
                      <AnimatePresence>
                        {files.map((f, i) => (
                          <motion.li
                            key={`${f.name}-${i}`}
                            variants={staggerItem}
                            initial="hidden"
                            animate="show"
                            exit="exit"
                            layout
                            className="flex items-center justify-between rounded-xl bg-dark-900 border border-transparent px-3 py-2.5 text-[13px]"
                          >
                            <span className="flex items-center gap-3 truncate text-zinc-300">
                              <ImageIcon className="w-3.5 h-3.5 text-gold-500/70 shrink-0" />
                              <span className="truncate">{f.name}</span>
                            </span>
                            <button onClick={() => removeFile(i)} className="text-zinc-600 hover:text-red-400 p-1 transition-colors">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </motion.li>
                        ))}
                      </AnimatePresence>
                    </motion.ul>

                    <motion.button
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={startProcessing}
                      className="w-full flex items-center justify-center gap-2
                                 rounded-xl bg-gold-500 text-black text-[13px] font-medium py-3.5 
                                 shadow-[0_0_15px_rgba(212,175,55,0.15)] hover:shadow-[0_0_20px_rgba(212,175,55,0.25)]
                                 transition-shadow"
                    >
                      <Sparkles className="w-4 h-4" />
                      Procesar Lote
                    </motion.button>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* PROCESSING / RESULT STATE */}
            {batch.status !== "idle" && (
              <motion.div
                key="processing"
                variants={fadeTransition}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex flex-col gap-6"
              >
                {/* Status Panel */}
                <div className="rounded-2xl border border-dark-800 bg-[#111] p-6 flex flex-col gap-5">
                  <div className="flex items-center gap-4">
                    <div className="relative flex items-center justify-center w-10 h-10 shrink-0">
                      {["uploading", "queued", "processing"].includes(batch.status) && (
                        <>
                          <div className="absolute inset-0 rounded-full border-2 border-dark-800" />
                          <motion.div 
                            className="absolute inset-0 rounded-full border-2 border-t-gold-500 border-r-gold-500 border-b-transparent border-l-transparent"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                          />
                        </>
                      )}
                      {batch.status === "completed" && <CheckCircle2 className="w-6 h-6 text-gold-500" />}
                      {batch.status === "failed" && <AlertTriangle className="w-6 h-6 text-red-500" />}
                    </div>

                    <div className="flex-1 truncate">
                      <p className="text-[13px] font-medium text-zinc-200">
                        {batch.status === "uploading" && "Subiendo..."}
                        {batch.status === "queued" && "En cola..."}
                        {batch.status === "processing" && "Eliminando marcas"}
                        {batch.status === "completed" && "Procesamiento completo"}
                        {batch.status === "failed" && "Error"}
                      </p>
                      <p className="text-[12px] text-zinc-500 mt-0.5 truncate">{batch.message}</p>
                    </div>
                  </div>

                  {/* Progress bar */}
                  {(batch.status === "processing" || batch.status === "completed") && (
                    <div className="flex flex-col gap-2">
                      <div className="flex justify-between text-[11px] font-medium text-zinc-500">
                        <span>Progreso</span>
                        <span>{batch.current} / {batch.total}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-dark-900 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-gold-500 shadow-[0_0_10px_rgba(212,175,55,0.5)]"
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ type: "spring", stiffness: 100, damping: 20 }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Cold-Start Warning */}
                  <AnimatePresence>
                    {isWakingUp && batch.status === "uploading" && (
                      <motion.div
                        initial={{ opacity: 0, y: -10, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="rounded-xl bg-gold-500/10 border border-gold-500/20 p-4 overflow-hidden"
                      >
                        <div className="flex gap-3">
                          <Sparkles className="w-5 h-5 text-gold-500 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-[13px] font-medium text-gold-500">Iniciando servidores de IA...</p>
                            <p className="text-[12px] text-gold-500/70 mt-1 leading-relaxed">
                              Por ser la primera petición del día, los servidores seguros están despertando. 
                              Esto puede tomar hasta 50 segundos. Por favor, no cierres la ventana.
                            </p>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Actions (Mobile-First iOS Native Share) */}
                  <div className="flex gap-3 pt-2">
                    {batch.status === "completed" && (
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={shareImages}
                        disabled={isSharing}
                        className="flex-1 flex items-center justify-center gap-2
                                   rounded-xl bg-gold-500 text-black text-[13px] font-medium py-3 px-2
                                   disabled:opacity-70 transition-opacity"
                      >
                        {isSharing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Share className="w-4 h-4" />}
                        <span className="truncate">{isSharing ? "Preparando..." : "Compartir / Guardar"}</span>
                      </motion.button>
                    )}
                    {(batch.status === "completed" || batch.status === "failed") && (
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={reset}
                        className="flex items-center justify-center gap-2
                                   rounded-xl bg-dark-900 text-zinc-300 text-[13px] font-medium py-3 px-4"
                      >
                        <RefreshCw className="w-4 h-4" />
                        <span className="hidden sm:inline">Nuevo</span>
                      </motion.button>
                    )}
                  </div>
                </div>

                {/* Thumbnails (Mobile-First Horizontal Carousel) */}
                {batch.files.length > 0 && (
                  <div className="relative -mx-5 px-5 sm:mx-0 sm:px-0">
                    <motion.div 
                      variants={staggerList}
                      initial="hidden"
                      animate="show"
                      className="flex sm:grid sm:grid-cols-5 gap-3 overflow-x-auto snap-x snap-mandatory pb-4 custom-scrollbar"
                    >
                      {batch.files.map((f, i) => (
                        <motion.button
                          key={i}
                          variants={staggerItem}
                          onClick={() => setSelectedIdx(i)}
                          whileTap={{ scale: 0.92 }}
                          className={`
                            shrink-0 w-20 sm:w-auto snap-start
                            relative aspect-square rounded-xl overflow-hidden
                            ${selectedIdx === i ? "ring-2 ring-gold-500 ring-offset-2 ring-offset-[#111]" : "opacity-60 hover:opacity-100"}
                            transition-all duration-200
                          `}
                        >
                          <img src={`${BACKEND}${f.processed}`} alt={f.name} className="w-full h-full object-cover" />
                        </motion.button>
                      ))}
                    </motion.div>
                  </div>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </section>

        {/* ─ Right panel: Comparator ─ */}
        <section className="lg:col-span-7">
          <AnimatePresence mode="popLayout">
            {active ? (
              <motion.div
                key="comparator"
                variants={fadeTransition}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex flex-col gap-4"
              >
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-zinc-300 font-medium truncate pr-4">
                    {active.name}
                  </span>
                  {batch.files.length > 1 && (
                    <div className="flex items-center gap-1">
                      <motion.button 
                        whileTap={{ scale: 0.9 }}
                        onClick={prev} 
                        disabled={selectedIdx === 0}
                        className="p-1.5 rounded-lg bg-dark-900 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </motion.button>
                      <span className="text-[12px] text-zinc-500 tabular-nums px-2">
                        {selectedIdx + 1} / {batch.files.length}
                      </span>
                      <motion.button 
                        whileTap={{ scale: 0.9 }}
                        onClick={next} 
                        disabled={selectedIdx === batch.files.length - 1}
                        className="p-1.5 rounded-lg bg-dark-900 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </motion.button>
                    </div>
                  )}
                </div>

                {/* Physics-based Image Compare Slider (Mobile-optimized with touch-none) */}
                <div 
                  ref={sliderRef}
                  onPointerMove={handlePointerMove}
                  onPointerDown={handlePointerDown}
                  className="relative w-full aspect-[4/3] rounded-2xl overflow-hidden bg-[#0A0A0A] touch-none cursor-ew-resize group select-none"
                >
                  {/* Before Image */}
                  <img
                    src={`${BACKEND}${active.original}`}
                    alt="Original"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                    draggable={false}
                  />
                  
                  {/* After Image (Clipped with Spring physics) */}
                  <motion.div
                    className="absolute inset-0"
                    style={{ clipPath: clipPathAfter }}
                  >
                    <img
                      src={`${BACKEND}${active.processed}`}
                      alt="Procesada"
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                      draggable={false}
                    />
                  </motion.div>

                  {/* Drag Handle (Spring physics) */}
                  <motion.div
                    className="absolute top-0 bottom-0 w-[1.5px] bg-gold-500 pointer-events-none"
                    style={{ left: handleLeft, boxShadow: "0 0 15px rgba(212,175,55,0.4)" }}
                  >
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                                    w-8 h-8 rounded-full bg-[#111] border border-gold-500/50
                                    flex items-center justify-center shadow-lg
                                    group-hover:scale-110 group-active:scale-95 transition-transform duration-300">
                      <div className="flex gap-1">
                        <div className="w-[1.5px] h-2.5 bg-gold-500/80 rounded-full" />
                        <div className="w-[1.5px] h-2.5 bg-gold-500/80 rounded-full" />
                      </div>
                    </div>
                  </motion.div>

                  {/* Labels */}
                  <div className="absolute bottom-4 left-4 px-2.5 py-1 rounded-md bg-black/50 backdrop-blur-md
                                   text-[11px] font-medium text-zinc-300 pointer-events-none border border-white/5">
                    Original
                  </div>
                  <div className="absolute bottom-4 right-4 px-2.5 py-1 rounded-md bg-gold-500/10 backdrop-blur-md
                                   text-[11px] font-medium text-gold-400 pointer-events-none border border-gold-500/20">
                    Procesada
                  </div>
                </div>

              </motion.div>
            ) : (
              /* Empty state */
              <motion.div
                key="empty"
                variants={fadeTransition}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex flex-col items-center justify-center text-center p-10 min-h-[400px] gap-5"
              >
                <div className="w-12 h-12 flex items-center justify-center rounded-full bg-dark-900">
                  <ImageIcon className="w-5 h-5 text-zinc-600" />
                </div>
                <div className="space-y-1.5">
                  <h3 className="text-[14px] font-medium text-zinc-300">
                    Comparador interactivo
                  </h3>
                  <p className="text-[13px] text-zinc-500 max-w-[280px]">
                    Sube y procesa un lote de imágenes para ver el resultado de la IA en detalle.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="mt-auto pt-16 pb-4">
        <p className="text-[12px] text-zinc-600">
          JotaTool &copy; {new Date().getFullYear()}
        </p>
      </footer>
    </div>
  );
}
