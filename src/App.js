import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isSameMonth, getDay, parseISO } from 'date-fns';
import { ChevronLeft, ChevronRight, Upload, PlusCircle, X, Loader, Rocket, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot, query, orderBy } from 'firebase/firestore';


// --- Helper Functions ---
const classNames = (...classes) => classes.filter(Boolean).join(' ');

// --- Sound Effects ---
const playSound = (type) => {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (!audioContext) return;

  if (type === 'rocket') {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(100, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(800, audioContext.currentTime + 0.3);
    gainNode.gain.setValueAtTime(0.2, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.3);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.3);
  }

  if (type === 'coin') {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.5);
  }
};

// --- Normalization helper (idempotent & defensive) ---
function normalizeExtractedData(t) {
  const n = (x) => (x == null || x === "" ? 0 : Number(String(x).replace(/[,$%\s+]/g, "")));
  const two = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const toISODate = (ds) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) return ds;
    const d = new Date(ds);
    if (!isNaN(d) && d.getFullYear() > 1980) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  };

  if (t.imageType === 'DAILY_SUMMARY') {
    return {
      type: 'DAILY_SUMMARY',
      date: toISODate(t.date),
      changeValue: two(n(t.changeValue)),
      changePercentage: two(n(t.changePercentage)),
      endOfDayBalance: two(n(t.endOfDayBalance)),
    };
  }

  let cost = Math.abs(n(t.costAtOpen));
  let credit = Math.abs(n(t.creditAtClose));
  let changeValue = Number.isFinite(n(t.changeValue)) ? n(t.changeValue) : 0;
  let changePercentage = Number.isFinite(n(t.changePercentage)) ? n(t.changePercentage) : 0;

  if (cost === 0 && changePercentage !== 0 && Number.isFinite(changePercentage)) {
    cost = Math.abs(changeValue / (changePercentage / 100));
    credit = cost + changeValue;
  }

  if (!Number.isFinite(changeValue) || (changeValue === 0 && credit > 0 && cost > 0)) {
    changeValue = two(credit - cost);
  }

  if (!Number.isFinite(changePercentage) || changePercentage === 0) {
    changePercentage = cost > 0 ? (changeValue / cost) * 100 : 0;
  }

  return {
    type: 'TRADE_CONFIRMATION',
    ticker: String(t.ticker || "").trim().toUpperCase(),
    date: toISODate(t.date || ""),
    costAtOpen: two(cost),
    creditAtClose: two(credit),
    changeValue: two(changeValue),
    changePercentage: two(changePercentage),
  };
}

// --- API Call to Gemini (handles multiple image types) ---
const analyzeImageWithGemini = async (base64ImageData) => {
  const prompt = `
Analyze the image and determine if it is a 'TRADE_CONFIRMATION' or a 'DAILY_SUMMARY'.

1. If it's a TRADE_CONFIRMATION (shows a single stock sell), extract these fields:
{ "imageType": "TRADE_CONFIRMATION", "ticker": STRING, "date": "YYYY-MM-DD", "costAtOpen": NUMBER, "creditAtClose": NUMBER, "changeValue": NUMBER, "changePercentage": NUMBER }
Rules:
- Date from "Closed on Mon DD, YYYY" or similar.
- Ticker is the first word.
- costAtOpen/creditAtClose are positive numbers.
- changeValue is signed dollars.
- changePercentage is signed percent.

2. If it's a DAILY_SUMMARY (shows a portfolio graph and total balance), extract these fields:
{ "imageType": "DAILY_SUMMARY", "date": "YYYY-MM-DD", "endOfDayBalance": NUMBER, "changeValue": NUMBER, "changePercentage": NUMBER }
Rules:
- The large dollar value at the top is 'endOfDayBalance'.
- The P/L for 'Today' is 'changeValue' (signed) and 'changePercentage' (signed).
- If no specific date is visible, assume today's date.

Return a single JSON object. Do not return an array. Provide null for fields that are not applicable to the image type.
  `;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64ImageData } }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          imageType: { type: "STRING", enum: ["TRADE_CONFIRMATION", "DAILY_SUMMARY"] },
          ticker: { type: "STRING" },
          date: { type: "STRING" },
          costAtOpen: { type: "NUMBER" },
          creditAtClose: { type: "NUMBER" },
          changeValue: { type: "NUMBER" },
          changePercentage: { type: "NUMBER" },
          endOfDayBalance: { type: "NUMBER" },
        },
        required: ["imageType", "date"],
      },
    },
  };

  const apiKey = "";
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

  try {
    const res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`API request failed with status ${res.status}`);
    const result = await res.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const raw = JSON.parse(text);
    return raw ? normalizeExtractedData(raw) : null;
  } catch (err) {
    console.error("Error calling Gemini API:", err);
    return null;
  }
};


// --- Components ---

const CalculatorPage = ({ trades, onClose, startingCapital }) => {
    const [startInvestment, setStartInvestment] = useState(startingCapital.toString());

    const { finalBalance, totalProfit, totalPercentage } = useMemo(() => {
        const startingAmount = parseFloat(startInvestment);
        if (isNaN(startingAmount) || startingAmount < 0) {
            return { finalBalance: 0, totalProfit: 0, totalPercentage: 0 };
        }

        const eventsByDate = trades.reduce((acc, event) => {
            const date = event.date;
            if (!acc[date]) acc[date] = [];
            acc[date].push(event);
            return acc;
        }, {});
       
        const sortedDates = Object.keys(eventsByDate).sort((a,b) => new Date(a) - new Date(b));

        let runningBalance = startingAmount;

        sortedDates.forEach(date => {
            const dailyEvents = eventsByDate[date];
            const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
            let dailyPercentChange = 0;

            if (summaryEvent) {
                dailyPercentChange = summaryEvent.changePercentage;
            } else {
                const dailyPnl = dailyEvents.reduce((sum, event) => sum + (event.changeValue || 0), 0);
                const dailyCost = dailyEvents.reduce((sum, event) => sum + (event.costAtOpen || 0), 0);
                if (dailyCost > 0) {
                    dailyPercentChange = (dailyPnl / dailyCost) * 100;
                }
            }
           
            runningBalance *= (1 + dailyPercentChange / 100);
        });

        const finalBalanceVal = runningBalance;
        const totalProfitVal = finalBalanceVal - startingAmount;
        const totalPercentageVal = startingAmount > 0 ? (totalProfitVal / startingAmount) * 100 : 0;

        return {
            finalBalance: finalBalanceVal,
            totalProfit: totalProfitVal,
            totalPercentage: totalPercentageVal,
        };
    }, [trades, startInvestment]);

    return (
        <div className="bg-background text-text-primary h-full w-full p-4 flex flex-col">
            <div className="flex justify-between items-center flex-shrink-0">
                <h2 className="text-xl font-semibold">Investment Projection</h2>
                <button onClick={onClose} className="p-1 rounded-full text-text-secondary hover:bg-white/10 transition-colors">
                    <X size={20} />
                </button>
            </div>
            <div className="flex-grow mt-6 overflow-y-auto">
                <div className="space-y-4">
                    <div>
                        <label className="text-sm font-medium text-text-secondary">Start Investment ($)</label>
                        <input 
                            type="number" 
                            value={startInvestment} 
                            onChange={(e) => setStartInvestment(e.target.value)} 
                            placeholder="e.g., 1000" 
                            className="w-full mt-1 p-3 bg-white/5 rounded-lg border border-glass-edge focus:ring-accent-blue focus:border-accent-blue" 
                        />
                    </div>
                </div>

                <div className="mt-8 pt-6 border-t border-glass-edge">
                    <h3 className="text-lg font-semibold text-text-primary mb-4">Projection Results</h3>
                    <p className="text-xs text-text-secondary mb-4">Based on all trades with daily profits/losses compounded.</p>
                    <div className="space-y-3">
                        <div className="flex justify-between items-center text-lg font-semibold text-text-primary">
                            <span>Total Profit / Loss:</span>
                            <span className={classNames('font-mono', totalProfit >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>
                                {totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
                            </span>
                        </div>
                        <div className="flex justify-between items-center text-lg font-semibold text-text-primary">
                            <span>Total Return (%):</span>
                            <span className={classNames('font-mono', totalPercentage >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>
                                {totalPercentage >= 0 ? '+' : ''}{isFinite(totalPercentage) ? totalPercentage.toFixed(2) : 0}%
                            </span>
                        </div>
                         <div className="flex justify-between items-center text-lg font-semibold text-text-primary">
                            <span>Final Balance:</span>
                            <span className="font-mono text-gold-metallic">
                                ${finalBalance.toFixed(2)}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const CalendarHeader = ({ currentMonth, prevMonth, nextMonth }) => (
    <div className="flex items-center justify-between px-1 pb-2">
        <h2 className="flex-auto text-lg font-semibold text-text-primary">{format(currentMonth, 'MMMM yyyy')}</h2>
        <button onClick={prevMonth} type="button" className="p-1.5 text-text-secondary hover:text-accent-blue transition-colors rounded-full hover:bg-white/10 button-hover-effect">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <button onClick={nextMonth} type="button" className="p-1.5 text-text-secondary hover:text-accent-blue transition-colors rounded-full hover:bg-white/10 button-hover-effect">
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
    </div>
);

const CalendarGrid = ({ currentMonth, trades, onDateSelect, selectedDate }) => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const startingDayOfWeek = getDay(monthStart);
    const getTradesForDay = (day) => trades.filter(trade => isSameDay(parseISO(trade.date), day));

    return (
        <div className="grid grid-cols-7 text-xs text-center">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <div key={index} className="py-2 font-medium text-text-secondary">{day}</div>)}
            {Array.from({ length: startingDayOfWeek }).map((_, i) => <div key={`empty-${i}`} />)}
            {days.map((day) => {
                const dailyEvents = getTradesForDay(day);
                const hasEvents = dailyEvents.length > 0;
                const isSelected = selectedDate && isSameDay(day, selectedDate);

                let dailyTotalPercent = 0;
                let dailyPnl = 0;

                if (hasEvents) {
                    const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
                   
                    if(summaryEvent) {
                        dailyPnl = summaryEvent.changeValue;
                        dailyTotalPercent = summaryEvent.changePercentage;
                    } else {
                        dailyPnl = dailyEvents.reduce((sum, event) => sum + event.changeValue, 0);
                        const totalCost = dailyEvents.reduce((sum, event) => sum + (event.costAtOpen || 0), 0);
                        if (totalCost > 0) {
                            dailyTotalPercent = (dailyPnl / totalCost) * 100;
                        }
                    }
                }
                return (
                    <div key={day.toString()} className="py-1 flex flex-col items-center min-h-[60px] sm:min-h-[70px]">
                        <button onClick={() => onDateSelect(day)} className={classNames('flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200 button-hover-effect', isSelected ? 'bg-accent-blue text-white font-semibold shadow-[0_0_15px_var(--color-accent-blue)]' : 'hover:bg-white/10', !isSameMonth(day, currentMonth) ? 'text-text-secondary/30' : 'text-text-primary')}>
                            <time dateTime={format(day, 'yyyy-MM-dd')}>{format(day, 'd')}</time>
                        </button>
                        {hasEvents && (
                            <div className="mt-1 text-center">
                                <>
                                    <p className={classNames('font-bold text-[11px]', dailyPnl >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>
                                        {dailyPnl >= 0 ? `+$${dailyPnl.toFixed(2)}` : `-$${Math.abs(dailyPnl).toFixed(2)}`}
                                    </p>
                                    <p className={classNames('text-text-secondary text-[10px]', dailyTotalPercent >= 0 ? 'text-accent-gain/80' : 'text-accent-loss/80')}>
                                        {dailyTotalPercent.toFixed(2)}%
                                    </p>
                                </>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

const SummaryViewModal = ({ selectedDate, trades, onClose, onDeleteTrade }) => {
    if (!selectedDate) return null;
    const dailyEvents = useMemo(() => trades.filter(trade => isSameDay(parseISO(trade.date), selectedDate)), [trades, selectedDate]);
    const dailyTotalPnl = useMemo(() => {
        const summary = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
        return summary ? summary.changeValue : dailyEvents.reduce((sum, event) => sum + event.changeValue, 0);
    }, [dailyEvents]);
    const dailyTotalPercent = useMemo(() => {
        const summary = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
        if (summary) return summary.changePercentage;
        const dailyTotalCost = dailyEvents.reduce((sum, event) => sum + (event.costAtOpen || 0), 0);
        if (dailyTotalCost > 0) return (dailyTotalPnl / dailyTotalCost) * 100;
        return 0;
    }, [dailyEvents, dailyTotalPnl]);

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
             <div className="bg-glass rounded-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-glass-edge flex-shrink-0">
                    <h3 className="text-lg font-semibold text-text-primary">Summary for <span className="text-accent-blue ml-1">{format(selectedDate, 'MMMM d, yyyy')}</span></h3>
                    <button onClick={onClose} className="p-1 rounded-full text-text-secondary hover:bg-white/10 transition-colors"><X size={20} /></button>
                </div>
                <div className="p-6 pt-4 overflow-y-auto">
                    <div className="flex justify-between items-baseline mb-4">
                        <h4 className="text-md text-text-secondary">Daily P/L</h4>
                        <div className="text-right">
                            <p className={classNames('text-2xl font-semibold', dailyTotalPnl >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>{dailyTotalPnl >= 0 ? '+' : ''}${dailyTotalPnl.toFixed(2)}</p>
                            <p className={classNames('text-sm', dailyTotalPercent >= 0 ? 'text-accent-gain/80' : 'text-accent-loss/80')}>{dailyTotalPercent >= 0 ? '+' : ''}{dailyTotalPercent.toFixed(2)}%</p>
                        </div>
                    </div>
                    {dailyEvents.length > 0 ? (
                        <ul className="space-y-3">
                            {dailyEvents.map(trade => (
                                <li key={trade.id} className="p-3 bg-white/5 rounded-lg hover:bg-white/10 transition-colors">
                                    <div className="flex justify-between items-center font-semibold">
                                        <span className="text-text-primary">{trade.type === 'DAILY_SUMMARY' ? 'Daily Summary' : trade.ticker}</span>
                                        <div className="flex items-center gap-2">
                                            <span className={classNames(trade.changeValue >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>${trade.changeValue.toFixed(2)}</span>
                                            <button onClick={() => onDeleteTrade(trade.id)} className="p-1 text-red-500 hover:text-red-400 rounded-full hover:bg-white/10 transition-colors">
                                                <Trash2 size={16} />
                                            </button>
                                        </div>
                                    </div>
                                    {trade.type === 'TRADE_CONFIRMATION' && (
                                        <div className="mt-2 text-xs text-text-secondary space-y-1">
                                            <div className="flex justify-between"><span>Cost at Open:</span> <span>${trade.costAtOpen.toFixed(2)}</span></div>
                                            <div className="flex justify-between"><span>Credit at Close:</span> <span>${trade.creditAtClose.toFixed(2)}</span></div>
                                            <div className="flex justify-between"><span>% Change:</span> <span>{trade.changePercentage.toFixed(2)}%</span></div>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-sm text-text-secondary mt-4">No individual trades for this day.</p>}
                </div>
            </div>
        </div>
    );
};

const AddTradeModal = ({ onAddTrade, setShowModal }) => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const fileInputRef = useRef(null);

    const handleFileChange = async (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        setLoading(true);
        setError(null);

        try {
            const newEvents = [];
            for (const file of files) {
                const base64String = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(",")[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                const extractedData = await analyzeImageWithGemini(base64String);
                if (extractedData) {
                    newEvents.push(extractedData);
                } else {
                    console.warn("Could not extract details from image:", file.name);
                }
            }

            if (newEvents.length > 0) {
                onAddTrade(newEvents);
                playSound('coin');
            }
            setShowModal(false);
        } catch (e) {
            console.error(e);
            setError("An error occurred while processing the image(s).");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center items-center z-50 p-4" onClick={() => setShowModal(false)}>
            <div className="bg-glass p-8 rounded-2xl w-full max-w-md relative" onClick={(e) => e.stopPropagation()}>
                 <button onClick={() => setShowModal(false)} className="absolute top-4 right-4 p-1 rounded-full text-text-secondary hover:bg-white/10 transition-colors"><X size={20} /></button>
                <h2 className="text-xl font-semibold text-text-primary mb-6">Log New Trade or Summary</h2>
                <div className="space-y-4">
                    <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/jpeg, image/png" multiple />
                    <button onClick={() => fileInputRef.current.click()} disabled={loading} className="w-full flex flex-col items-center justify-center p-8 border-2 border-dashed border-glass-edge rounded-lg text-text-secondary hover:border-accent-blue hover:text-accent-blue transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {loading ? <Loader className="animate-spin h-8 w-8" /> : <> <Upload className="h-8 w-8" /> <span className="mt-2 text-sm font-medium">Click to upload image(s)</span> </>}
                    </button>
                    {loading && <p className="text-center text-sm text-accent-blue animate-pulse">Analyzing Image...</p>}
                    {error && <p className="text-center text-sm text-accent-loss">{error}</p>}
                </div>
            </div>
        </div>
    );
};

const PnlHistoryModal = ({ trades, startingCapital, onClose, onDeleteTrade }) => {
    const history = useMemo(() => {
        if (trades.length === 0) return [];

        const eventsByDate = trades.reduce((acc, event) => {
            const date = event.date;
            if (!acc[date]) acc[date] = [];
            acc[date].push(event);
            return acc;
        }, {});

        const sortedDates = Object.keys(eventsByDate).sort((a, b) => new Date(a) - new Date(b));
        let runningBalance = startingCapital;
        
        const historyItems = [];

        sortedDates.forEach(date => {
            const dailyEvents = eventsByDate[date];
            const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
           
            const dailyPnl = summaryEvent 
                ? summaryEvent.changeValue 
                : dailyEvents.reduce((sum, event) => sum + (event.changeValue || 0), 0);
           
            if (summaryEvent) {
                runningBalance = summaryEvent.endOfDayBalance;
            } else {
                runningBalance += dailyPnl;
            }

            dailyEvents.forEach(event => {
                historyItems.push({ ...event, endOfDayBalance: runningBalance });
            });
        });
        return historyItems.sort((a,b) => new Date(b.date) - new Date(a.date));

    }, [trades, startingCapital]);

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-glass rounded-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-glass-edge flex-shrink-0">
                    <h3 className="text-lg font-semibold text-text-primary">Account History</h3>
                    <button onClick={onClose} className="p-1 rounded-full text-text-secondary hover:bg-white/10 transition-colors"><X size={20} /></button>
                </div>
                <div className="p-6 pt-4 overflow-y-auto max-h-[60vh]">
                    {history.length > 0 ? (
                        <ul className="space-y-3">
                            {history.map((item) => (
                                <li key={item.id} className="p-3 bg-white/5 rounded-lg flex justify-between items-center">
                                    <div className="flex flex-col">
                                        <span className="text-text-primary font-medium">{item.type === 'DAILY_SUMMARY' ? 'Daily Summary' : item.ticker}</span>
                                        <span className="text-xs text-text-secondary">{format(parseISO(item.date), 'MMMM d, yyyy')}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className="text-right">
                                            <span className={classNames('font-semibold', item.changeValue >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>
                                                {item.changeValue >= 0 ? '+' : ''}${item.changeValue.toFixed(2)}
                                            </span>
                                            <p className={classNames('text-xs', item.changePercentage >= 0 ? 'text-accent-gain/80' : 'text-accent-loss/80')}>
                                                {item.changePercentage >= 0 ? '+' : ''}{item.changePercentage.toFixed(2)}%
                                            </p>
                                        </div>
                                        <button onClick={() => onDeleteTrade(item.id)} className="p-1 text-red-500 hover:text-red-400 rounded-full hover:bg-white/10 transition-colors">
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-sm text-text-secondary mt-4">No trading history.</p>}
                </div>
            </div>
        </div>
    );
};

const WinRateModal = ({ trades, onClose }) => {
    const { dailyPnlList, winningDays, totalTradingDays, winRate } = useMemo(() => {
        const eventsByDate = trades.reduce((acc, event) => {
            const date = event.date;
            if (!acc[date]) acc[date] = [];
            acc[date].push(event);
            return acc;
        }, {});

        const pnlList = Object.keys(eventsByDate).map(date => {
            const dailyEvents = eventsByDate[date];
            const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
            const dailyPnl = summaryEvent
                ? summaryEvent.changeValue
                : dailyEvents.reduce((sum, event) => sum + (event.changeValue || 0), 0);
            return { date, dailyPnl, isWin: dailyPnl > 0 };
        }).sort((a,b) => new Date(a.date) - new Date(b.date));

        const totalDays = pnlList.length;
        const winning = pnlList.filter(d => d.isWin).length;
        const rate = totalDays > 0 ? (winning / totalDays) * 100 : 0;

        return { dailyPnlList: pnlList, winningDays: winning, totalTradingDays: totalDays, winRate: rate };
    }, [trades]);

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-glass rounded-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-glass-edge flex-shrink-0">
                    <h3 className="text-lg font-semibold text-text-primary">Win Rate Calculation</h3>
                    <button onClick={onClose} className="p-1 rounded-full text-text-secondary hover:bg-white/10 transition-colors"><X size={20} /></button>
                </div>
                <div className="p-6 pt-4 overflow-y-auto max-h-[60vh]">
                    <div className="p-4 bg-white/5 rounded-lg mb-4 text-center">
                        <p className="text-text-secondary text-sm">Formula</p>
                        <p className="text-text-primary font-mono text-lg mt-1">
                           (<span className="text-accent-gain">{winningDays}</span> Winning Days / <span className="text-text-primary">{totalTradingDays}</span> Total Days) * 100 = <span className="text-accent-blue">{winRate.toFixed(2)}%</span>
                        </p>
                    </div>
                    <h4 className="text-md font-semibold text-text-secondary mb-2">Daily Breakdown</h4>
                    {dailyPnlList.length > 0 ? (
                        <ul className="space-y-2">
                            {dailyPnlList.map((item) => (
                                <li key={item.date} className="p-3 bg-white/5 rounded-lg flex justify-between items-center text-sm">
                                    <span className="text-text-primary font-medium">{format(parseISO(item.date), 'MMMM d, yyyy')}</span>
                                    <div className="flex items-center gap-4">
                                        <span className={classNames('font-mono', item.isWin ? 'text-accent-gain' : 'text-accent-loss')}>
                                            {item.dailyPnl >= 0 ? '+' : ''}${item.dailyPnl.toFixed(2)}
                                        </span>
                                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${item.isWin ? 'bg-accent-gain/20 text-accent-gain' : 'bg-accent-loss/20 text-accent-loss'}`}>
                                            {item.isWin ? 'Win' : 'Loss'}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="text-sm text-text-secondary mt-4">No trading days to analyze.</p>}
                </div>
            </div>
        </div>
    );
};


// --- Main App Component ---
function App() {
    const [trades, setTrades] = useState([]);
    const [currentMonth, setCurrentMonth] = useState(new Date());
    const [selectedDate, setSelectedDate] = useState(null);
    const [showAddTradeModal, setShowAddTradeModal] = useState(false);
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [showCalculator, setShowCalculator] = useState(false);
    const [showWinRateModal, setShowWinRateModal] = useState(false);
    const [startingCapital, setStartingCapital] = useState(500);
    const [isLoading, setIsLoading] = useState(true);
    
    // Firebase state
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);

    const prevMonth = () => setCurrentMonth(subMonths(currentMonth, 1));
    const nextMonth = () => setCurrentMonth(addMonths(currentMonth, 1));

    // --- Firebase Initialization ---
    useEffect(() => {
        try {
            const firebaseConfigStr = typeof __firebase_config !== 'undefined' ? __firebase_config : null;
            if (firebaseConfigStr && firebaseConfigStr.startsWith('{')) {
                const firebaseConfig = JSON.parse(firebaseConfigStr);
                const app = initializeApp(firebaseConfig);
                const auth = getAuth(app);
                const firestore = getFirestore(app);
                setDb(firestore);

                onAuthStateChanged(auth, (user) => {
                    if (user) {
                        setUserId(user.uid);
                    }
                });

                const signIn = async () => {
                    const authToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
                    try {
                        if (authToken) {
                            await signInWithCustomToken(auth, authToken);
                        } else {
                            await signInAnonymously(auth);
                        }
                    } catch (error) {
                        console.error("Firebase sign-in failed:", error);
                    }
                };
                signIn();
            } else {
                setIsLoading(false);
            }
        } catch (error) {
            console.error("Error initializing Firebase:", error);
            setIsLoading(false);
        }
    }, []);

    // --- Firebase Data Listener ---
    useEffect(() => {
        if (db && userId) {
            setIsLoading(true);
            const tradesCollectionRef = collection(db, 'artifacts', window.__app_id || 'default-app-id', 'public', 'data', 'trades');
            const q = query(tradesCollectionRef, orderBy("date"));

            const unsubscribe = onSnapshot(q, (querySnapshot) => {
                const tradesData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setTrades(tradesData);
                setIsLoading(false);
            }, (error) => {
                console.error("Error fetching trades:", error);
                setIsLoading(false);
            });

            // Cleanup subscription on unmount
            return () => unsubscribe();
        }
    }, [db, userId]);

    const handleAddTrade = async (newEvents) => {
        if (!db || !userId) return;
        const tradesCollectionRef = collection(db, 'artifacts', window.__app_id || 'default-app-id', 'public', 'data', 'trades');
        
        for (const event of newEvents) {
            await addDoc(tradesCollectionRef, event);
        }

        const lastNewEvent = newEvents[newEvents.length - 1];
        if (lastNewEvent) {
            const newTradeDate = parseISO(lastNewEvent.date);
            setCurrentMonth(startOfMonth(newTradeDate));
        }
    };
    
    const handleDeleteTrade = async (tradeId) => {
        if (!db || !userId) return;
        const tradeDocRef = doc(db, 'artifacts', window.__app_id || 'default-app-id', 'public', 'data', 'trades', tradeId);
        await deleteDoc(tradeDocRef);
    };
   
    const handleDateSelect = (day) => setSelectedDate(day);

    const { pnlFromTrades, balanceFromTrades, winRate } = useMemo(() => {
        const eventsByDate = trades.reduce((acc, event) => {
            const date = event.date;
            if (!acc[date]) acc[date] = [];
            acc[date].push(event);
            return acc;
        }, {});

        let totalPnl = 0;
        for (const date in eventsByDate) {
            const dailyEvents = eventsByDate[date];
            const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');

            let dailyPnl = 0;
            if (summaryEvent) {
                dailyPnl = summaryEvent.changeValue;
            } else {
                dailyPnl = dailyEvents.reduce((sum, event) => {
                    if (event.type === 'TRADE_CONFIRMATION') {
                        return sum + (event.changeValue || 0);
                    }
                    return sum;
                }, 0);
            }
            totalPnl += dailyPnl;
        }

        const latestSummary = trades
            .filter(t => t.type === 'DAILY_SUMMARY')
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

        let balance = latestSummary ? latestSummary.endOfDayBalance : startingCapital + totalPnl;

        let winningDays = 0;
        const tradingDays = Object.keys(eventsByDate).length;
        for (const date in eventsByDate) {
            const dailyEvents = eventsByDate[date];
            const summaryEvent = dailyEvents.find(e => e.type === 'DAILY_SUMMARY');
            let pnlForDay = 0;
             if (summaryEvent) {
                pnlForDay = summaryEvent.changeValue;
            } else {
                pnlForDay = dailyEvents.reduce((sum, event) => {
                    if (event.type === 'TRADE_CONFIRMATION') {
                        return sum + (event.changeValue || 0);
                    }
                    return sum;
                }, 0);
            }
            if (pnlForDay > 0) winningDays++;
        }
        const newWinRate = tradingDays > 0 ? (winningDays / tradingDays) * 100 : 0;

        return { pnlFromTrades: totalPnl, balanceFromTrades: balance, winRate: newWinRate };
    }, [trades, startingCapital]);

    if (isLoading && !db) {
        return (
            <div className="bg-background text-text-primary min-h-screen w-full flex items-center justify-center">
                <p>Initializing Firebase...</p>
            </div>
        )
    }
    
    if (isLoading) {
        return (
            <div className="bg-background text-text-primary min-h-screen w-full flex items-center justify-center">
                <Icon name="Loader" className="animate-spin h-12 w-12 text-accent-blue" />
            </div>
        )
    }

    return (
        <React.Fragment>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Inter:wght@400;500;600;700&display=swap');
                :root {
                    --color-background: #000000; --color-text-primary: #FFFFFF; --color-text-secondary: #8E8E93;
                    --color-accent-blue: #00BFFF; --color-accent-gain: #30D158; --color-accent-loss: #FF453A;
                    --color-glass-bg: rgba(28, 28, 30, 0.7); --color-glass-edge: rgba(255, 255, 255, 0.1);
                }
                .bg-background { background-color: var(--color-background); } .text-text-primary { color: var(--color-text-primary); }
                .text-text-secondary { color: var(--color-text-secondary); } .text-accent-blue { color: var(--color-accent-blue); }
                .text-accent-gain { color: var(--color-accent-gain); } .text-accent-loss { color: var(--color-accent-loss); }
                .border-glass-edge { border-color: var(--color-glass-edge); } body { font-family: 'Inter', sans-serif; background-color: var(--color-background); }
                .font-title { font-family: 'Orbitron', sans-serif; }
                .bg-glass { background-color: var(--color-glass-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--color-glass-edge); }
                .stat-card-3d { background: linear-gradient(145deg, rgba(40, 40, 42, 0.7), rgba(20, 20, 22, 0.7)); border-radius: 20px; padding: 1.5rem; box-shadow: 5px 5px 15px #0a0a0a, -5px -5px 15px #1e1e1e; transition: all 0.3s ease-in-out; border: 1px solid var(--color-glass-edge); backdrop-filter: blur(10px); }
                .stat-card-3d:hover { transform: translateY(-5px) scale(1.02); box-shadow: 8px 8px 25px #0a0a0a, -8px -8px 25px #1e1e1e, inset 0 0 20px rgba(0, 191, 255, 0.2); }
                .text-gold-metallic { background: linear-gradient(145deg, #BF953F, #FCF6BA, #B38728, #FBF5B7, #AA771C); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0px 1px 2px rgba(0,0,0,0.3); }
                .text-silver-metallic { background: linear-gradient(145deg, #c0c0c0, #d7d7d7, #ffffff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-shadow: 0px 1px 2px rgba(0,0,0,0.5); }
                /* --- metallic silver rocket button --- */
                .rocket-btn {
                    background: linear-gradient(145deg, #c0c0c0, #e0e0e0, #ffffff);
                    color: #111111;              /* dark icon on light metal */
                    box-shadow: inset 0 1px 3px rgba(255,255,255,0.6),
                                inset 0 -1px 3px rgba(0,0,0,0.15),
                                0 3px 6px rgba(0,0,0,0.4);
                }
                .rocket-btn:hover {
                    box-shadow: inset 0 1px 3px rgba(255,255,255,0.8),
                                inset 0 -1px 3px rgba(0,0,0,0.2),
                                0 6px 10px rgba(0,0,0,0.6);
                }
                 .button-hover-effect:hover { transform: scale(1.15); }
            `}</style>
            <div className="bg-background text-text-primary min-h-screen w-full">
                <main className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-4xl">
                    <header className="mb-8 text-center">
                        <h1 className="font-title text-3xl sm:text-5xl tracking-wider text-silver-metallic">5blackwatchtrail</h1>
                    </header>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
                         <div className="stat-card-3d" onMouseEnter={() => playSound('coin')}>
                            <h2 className="text-sm font-medium text-gold-metallic">Account Balance</h2>
                            <p className="text-3xl font-semibold text-gold-metallic mt-1">${balanceFromTrades.toFixed(2)}</p>
                        </div>
                        <div className="stat-card-3d cursor-pointer" onClick={() => setShowHistoryModal(true)}>
                            <h2 className="text-sm font-medium text-text-secondary">Total Realized P/L</h2>
                            <p className={classNames('text-3xl font-semibold mt-1', pnlFromTrades >= 0 ? 'text-accent-gain' : 'text-accent-loss')}>
                                {pnlFromTrades >= 0 ? '+' : ''}${pnlFromTrades.toFixed(2)}
                            </p>
                        </div>
                         <div className="stat-card-3d cursor-pointer" onClick={() => setShowWinRateModal(true)}>
                            <h2 className="text-sm font-medium text-text-secondary">Win Rate</h2>
                            <p className={classNames('text-3xl font-semibold mt-1', winRate >= 50 ? 'text-accent-gain' : 'text-accent-loss')}>{winRate.toFixed(2)}%</p>
                        </div>
                    </div>
                    <div className="bg-glass p-4 sm:p-6 rounded-xl">
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-xl font-semibold text-silver-metallic">Trade Calendar</h2>
                            <div className="flex items-center gap-3">
                                <button
                                onClick={() => setShowAddTradeModal(true)}
                                title="Log Trade"
                                className="flex items-center justify-center w-10 h-10 bg-accent-blue text-white rounded-full
                                             transition-all duration-200 hover:shadow-lg hover:shadow-accent-blue/30 button-hover-effect"
                                >
                                <Icon name="PlusCircle" size={20} />
                                </button>
                                <button
                                onClick={() => { playSound('rocket'); setShowCalculator(true); }}
                                title="Open P/L Calculator"
                                className="rocket-btn flex items-center justify-center w-10 h-10 rounded-full
                                             transition-all duration-200 hover:shadow-lg button-hover-effect"
                                >
                                <Icon name="Rocket" size={18} />
                                </button>
                            </div>
                        </div>
                        <CalendarHeader currentMonth={currentMonth} prevMonth={prevMonth} nextMonth={nextMonth} />
                        <CalendarGrid trades={trades} currentMonth={currentMonth} onDateSelect={handleDateSelect} selectedDate={selectedDate} />
                    </div>
                </main>
                {selectedDate && <SummaryViewModal selectedDate={selectedDate} trades={trades} onClose={() => setSelectedDate(null)} onDeleteTrade={handleDeleteTrade} />}
                {showAddTradeModal && <AddTradeModal onAddTrade={handleAddTrade} setShowModal={setShowAddTradeModal} />}
                {showHistoryModal && <PnlHistoryModal trades={trades} startingCapital={startingCapital} onClose={() => setShowHistoryModal(false)} onDeleteTrade={handleDeleteTrade} />}
                {showWinRateModal && <WinRateModal trades={trades} onClose={() => setShowWinRateModal(false)} />}
               
                <AnimatePresence>
                {showCalculator && (
                    <motion.div
                    key="calc"
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    exit={{ x: '100%' }}
                    transition={{ type: 'tween', duration: 0.35 }}
                    className="fixed inset-0 z-50"
                    >
                    <CalculatorPage
                        trades={trades}
                        onClose={() => setShowCalculator(false)}
                        startingCapital={startingCapital}
                    />
                    </motion.div>
                )}
                </AnimatePresence>
            </div>
        </React.Fragment>
    );
}
