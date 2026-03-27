'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Zap, Check, TrendingDown, FileText, Search, CreditCard, Sparkles, ArrowRight, Gift } from 'lucide-react';
import { useTheme } from '@/contexts/theme-context';

// ============================================================================
// 定价档位
// ============================================================================

interface PricingTier {
  id: string;
  name: string;
  price: number;        // 美元
  credits: number;
  pricePerCredit: number;
  features: string[];
  gradient: { from: string; to: string };
  isFeatured?: boolean;
  isFree?: boolean;
  isCustom?: boolean;
}

const PRICING_TIERS: PricingTier[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    credits: 100,
    pricePerCredit: 0,
    features: ['100 Free Credits', 'Try all features', 'No credit card required'],
    gradient: { from: '#10B981', to: '#34D399' },
    isFree: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 49.90,
    credits: 25000,
    pricePerCredit: 0.002,
    features: ['25,000 Credits', 'Priority Queue', '10 Concurrent Requests'],
    gradient: { from: '#41086D', to: '#724CFF' },
    isFeatured: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 199,
    credits: 150000,
    pricePerCredit: 0.00133,
    features: ['150,000+ Credits', 'Dedicated Instances', 'Unlimited Concurrency'],
    gradient: { from: '#0F3E82', to: '#6297EB' },
    isCustom: true,
  },
];

// ============================================================================
// 每个 Credit 可处理的内容估算
// 基于定价: 1 Credit = $0.002
// ============================================================================
// 
// | 操作 | Credits | 1 Credit 可处理 |
// |------|---------|-----------------|
// | Parse Fast | 2/页 | 0.5 页 |
// | Parse HiRes | 5/页 | 0.2 页 |
// | 压缩 (HQCC) | 8/1K tokens | 125 tokens |
// | Exa 搜索 | 20/次 | 0.05 次 |
// 
// 典型 Load 任务费用:
// - URL 压缩 (假设 2K tokens 输出): 16 credits
// - Query 搜索 + 压缩: 20 + 16 = 36 credits
// ============================================================================

const CONTENT_PER_CREDIT = {
  // Parse Fast: 1 credit = 0.5 页 (2 credits/页)
  parsePages: 0.5,
  // Parse HiRes: 1 credit = 0.2 页 (5 credits/页)
  hiresPages: 0.2,
  // 压缩输出: 1 credit = 125 tokens (8 credits/1K tokens)
  tokens: 125,
  // Exa 搜索: 1 credit = 0.05 次 (20 credits/次)
  searches: 0.05,
};

// ============================================================================
// Component
// ============================================================================

interface CreditPurchaseSliderProps {
  onPurchase?: (credits: number, priceCents: number) => void;
  disabled?: boolean;
  loading?: boolean;
  /** 'dashboard' (default) triggers onPurchase; 'landing' renders a Link to /auth */
  variant?: 'dashboard' | 'landing';
}

export function CreditPurchaseSlider({ onPurchase, disabled, loading, variant = 'dashboard' }: CreditPurchaseSliderProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  
  // Slider: 0 = Free, 1-100 = 连续金额 ($1 到 $300)
  const [sliderValue, setSliderValue] = useState(50); // 默认 Pro ($49.90)
  
  // Slider 值对应的档位
  const SLIDER_FREE = 0;
  const SLIDER_PRO = 50;      // Pro 推荐档位
  const SLIDER_ENTERPRISE = 100;
  
  // 金额范围
  const MIN_PRICE = 1;        // 最低 $1
  const PRO_PRICE = 49.90;    // Pro $49.90
  const MAX_PRICE = 300;      // 最高 $300
  
  // 计算当前定价（连续滑动）
  const currentPricing = useMemo(() => {
    if (sliderValue <= SLIDER_FREE) {
      return PRICING_TIERS[0]; // Free
    }
    
    // 计算价格（连续滑动）
    let price: number;
    if (sliderValue <= SLIDER_PRO) {
      // 0-50: $1 到 $49.90
      const progress = sliderValue / SLIDER_PRO;
      price = MIN_PRICE + progress * (PRO_PRICE - MIN_PRICE);
    } else {
      // 50-100: $49.90 到 $300
      const progress = (sliderValue - SLIDER_PRO) / (SLIDER_ENTERPRISE - SLIDER_PRO);
      price = PRO_PRICE + progress * (MAX_PRICE - PRO_PRICE);
    }
    price = Math.round(price * 100) / 100; // 保留两位小数
    
    // 阶梯定价：越多越便宜
    let pricePerCredit: number;
    if (price <= 49.90) {
      pricePerCredit = 0.002;      // $0.002/credit
    } else if (price <= 150) {
      pricePerCredit = 0.00133;    // $0.00133/credit (33% off)
    } else {
      pricePerCredit = 0.001;      // $0.001/credit (50% off)
    }
    
    const credits = Math.round(price / pricePerCredit);
    
    // 判断是哪个档位
    const isProPrice = Math.abs(price - PRO_PRICE) < 1;
    const isEnterprisePrice = price >= 150;
    
    if (isProPrice) {
      return {
        ...PRICING_TIERS[1],
        price,
        credits,
        pricePerCredit,
      };
    } else if (isEnterprisePrice) {
      return {
        id: 'enterprise-custom',
        name: 'Enterprise',
        price,
        credits,
        pricePerCredit,
        features: PRICING_TIERS[2].features,
        gradient: PRICING_TIERS[2].gradient,
        isCustom: true,
        isFeatured: false,
      };
    } else {
      return {
        id: 'custom',
        name: 'Custom',
        price,
        credits,
        pricePerCredit,
        features: ['Pay as you go', `${credits.toLocaleString()} Credits`, 'All features included'],
        gradient: { from: '#6366F1', to: '#8B5CF6' },
        isCustom: true,
      };
    }
  }, [sliderValue]);
  
  // 折扣率 (相对于 Pro 单价)
  const discountPercent = useMemo(() => {
    if (currentPricing.isFree) return 0;
    const proRate = PRICING_TIERS[1].pricePerCredit;
    const currentRate = currentPricing.pricePerCredit;
    return Math.round((1 - currentRate / proRate) * 100);
  }, [currentPricing]);
  
  // 内容估算
  // 内容处理量估算
  const contentEstimate = useMemo(() => {
    const credits = currentPricing.credits;
    const totalTokens = credits * CONTENT_PER_CREDIT.tokens;
    
    // 格式化 tokens 显示
    let tokensDisplay: string;
    if (totalTokens >= 1000000) {
      tokensDisplay = (totalTokens / 1000000).toFixed(1) + 'M';
    } else if (totalTokens >= 1000) {
      tokensDisplay = Math.round(totalTokens / 1000) + 'K';
    } else {
      tokensDisplay = Math.round(totalTokens).toString();
    }
    
    return {
      // Parse Fast 页数
      parsePages: Math.round(credits * CONTENT_PER_CREDIT.parsePages).toLocaleString(),
      // Parse HiRes 页数
      hiresPages: Math.round(credits * CONTENT_PER_CREDIT.hiresPages).toLocaleString(),
      // 压缩输出 tokens
      tokens: tokensDisplay,
      // Exa 搜索次数
      searches: Math.round(credits * CONTENT_PER_CREDIT.searches).toLocaleString(),
    };
  }, [currentPricing]);
  
  const handlePurchase = () => {
    if (currentPricing.isFree || !onPurchase) return;
    const priceCents = Math.round(currentPricing.price * 100);
    onPurchase(currentPricing.credits, priceCents);
  };
  
  // 判断当前选中的是哪个档位（用于高亮卡片）
  const activeTierIndex = useMemo(() => {
    if (sliderValue <= SLIDER_FREE) return 0;           // Free
    if (Math.abs(sliderValue - SLIDER_PRO) <= 2) return 1;  // Pro (允许±2的误差)
    if (sliderValue >= SLIDER_ENTERPRISE - 2) return 2;  // Enterprise
    return -1; // Custom（不高亮任何卡片）
  }, [sliderValue]);
  
  // 点击卡片时对应的 slider 值
  const tierToSlider = [SLIDER_FREE, SLIDER_PRO, SLIDER_ENTERPRISE];
  
  return (
    <div className="space-y-8">
      {/* Pricing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
        {PRICING_TIERS.map((tier, index) => {
          const isActive = activeTierIndex === index;
          const isFeatured = tier.isFeatured;
          const isFree = tier.isFree;
          
          return (
            <div 
              key={tier.id}
              onClick={() => setSliderValue(tierToSlider[index])}
              className={`group relative min-h-[320px] cursor-pointer transition-transform ${
                isActive ? 'scale-[1.02] md:scale-105' : 'hover:scale-[1.01]'
              } ${isFeatured ? 'order-first md:order-none' : ''}`}
            >
              {/* Skewed gradient panels */}
              <span
                className={`absolute top-0 left-[30px] w-[55%] h-full rounded-2xl transform skew-x-[12deg] transition-all duration-500 ease-out ${
                  isActive ? 'skew-x-0 left-[10px] w-[calc(100%-20px)]' : 'group-hover:skew-x-[6deg]'
                } ${isDark ? (isActive ? 'opacity-90' : 'opacity-60 group-hover:opacity-75') : (isActive ? 'opacity-80' : 'opacity-40 group-hover:opacity-60')}`}
                style={{ background: `linear-gradient(135deg, ${tier.gradient.from}, ${tier.gradient.to})` }}
              />
              <span
                className={`absolute top-0 left-[30px] w-[55%] h-full rounded-2xl transform skew-x-[12deg] blur-[40px] transition-all duration-500 ease-out ${
                  isActive ? 'skew-x-0 left-[10px] w-[calc(100%-20px)] opacity-50' : 'opacity-20 group-hover:opacity-35'
                }`}
                style={{ background: `linear-gradient(135deg, ${tier.gradient.from}, ${tier.gradient.to})` }}
              />
              
              {/* Corner blurs */}
              <span className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl">
                <span className={`absolute -top-8 -left-8 w-0 h-0 rounded-full opacity-0 backdrop-blur-md transition-all duration-500 ${
                  isActive ? 'w-16 h-16 opacity-100' : 'group-hover:w-12 group-hover:h-12 group-hover:opacity-50'
                } ${isDark ? 'bg-white/10' : 'bg-violet-500/10'}`} />
                <span className={`absolute -bottom-8 -right-8 w-0 h-0 rounded-full opacity-0 backdrop-blur-md transition-all duration-700 delay-100 ${
                  isActive ? 'w-20 h-20 opacity-100' : 'group-hover:w-14 group-hover:h-14 group-hover:opacity-50'
                } ${isDark ? 'bg-white/10' : 'bg-violet-500/10'}`} />
              </span>
              
              {/* Badges */}
              {isFeatured && (
                <div className="absolute top-4 right-4 z-30 px-3 py-1.5 bg-gradient-to-r from-violet-600 to-purple-500 text-white text-xs font-bold rounded-full shadow-lg flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> RECOMMENDED
                </div>
              )}
              {isFree && (
                <div className="absolute top-4 right-4 z-30 px-3 py-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-xs font-bold rounded-full shadow-lg flex items-center gap-1">
                  <Gift className="w-3 h-3" /> FREE
                </div>
              )}
              
              {/* Active dot */}
              {isActive && (
                <div className={`absolute top-4 left-4 z-30 w-3 h-3 rounded-full animate-pulse ${
                  isFree ? 'bg-emerald-400' : isFeatured ? 'bg-violet-400' : 'bg-blue-400'
                }`} />
              )}
              
              {/* Content */}
              <div className={`relative z-20 h-full p-6 backdrop-blur-xl border rounded-2xl transition-all duration-500 ease-out flex flex-col ${
                isActive
                  ? (isDark 
                      ? 'bg-zinc-900/60 border-white/20 shadow-2xl' 
                      : 'bg-white/80 border-violet-300 shadow-2xl shadow-violet-500/10')
                  : (isDark 
                      ? 'bg-zinc-900/40 border-white/10 group-hover:bg-zinc-900/50' 
                      : 'bg-white/60 border-zinc-200 group-hover:bg-white/70')
              }`}>
                <h3 className={`text-lg font-bold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  {tier.name}
                </h3>
                <div className={`text-3xl font-bold mb-3 ${
                  isFree 
                    ? 'text-emerald-500'
                    : isFeatured 
                      ? 'text-transparent bg-clip-text bg-gradient-to-r from-violet-500 to-purple-500' 
                      : (isDark ? 'text-white' : 'text-zinc-900')
                }`}>
                  {isFree ? 'Free' : `$${tier.price}`}
                  {!isFree && (
                    <span className={`text-sm font-normal ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {' '}/ one-time
                    </span>
                  )}
                </div>
                
                <ul className={`space-y-2 text-sm flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {tier.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <Check className={`w-4 h-4 flex-shrink-0 ${isFree ? 'text-emerald-500' : 'text-emerald-500'}`} />
                      {feature}
                    </li>
                  ))}
                </ul>
                
                {/* Enterprise contact link */}
                {tier.isCustom && (
                  <a 
                    href="mailto:info@prismer.ai?subject=Enterprise%20Inquiry"
                    onClick={(e) => e.stopPropagation()}
                    className={`block text-center text-xs mt-2 transition-colors ${
                      isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-500'
                    }`}
                  >
                    Need more? Contact us →
                  </a>
                )}
                
                <div className={`mt-4 py-2 text-center text-sm font-medium rounded-lg transition-all ${
                  isActive
                    ? (isFree
                        ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white'
                        : isFeatured 
                          ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white' 
                          : (isDark ? 'bg-white/20 text-white' : 'bg-zinc-900 text-white'))
                    : (isDark ? 'bg-white/5 text-zinc-400' : 'bg-zinc-100 text-zinc-500')
                }`}>
                  {isActive ? 'Selected' : 'Click to select'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Slider */}
      <div className={`p-6 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-zinc-200 shadow-sm'}`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              Adjust Amount
            </h4>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Drag right for volume discounts
            </p>
          </div>
          {discountPercent > 0 && (
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${
              isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
            }`}>
              <TrendingDown className="w-4 h-4" />
              Save {discountPercent}%
            </div>
          )}
        </div>
        
        {/* Slider labels */}
        <div className="flex justify-between mb-2">
          <span className={`text-xs font-medium ${activeTierIndex === 0 ? 'text-emerald-500' : (isDark ? 'text-zinc-500' : 'text-zinc-400')}`}>
            Free
          </span>
          <span className={`text-xs font-medium ${activeTierIndex === 1 ? 'text-violet-500' : (isDark ? 'text-zinc-500' : 'text-zinc-400')}`}>
            Pro $49.90
          </span>
          <span className={`text-xs font-medium ${activeTierIndex === 2 ? 'text-blue-500' : (isDark ? 'text-zinc-500' : 'text-zinc-400')}`}>
            Enterprise+
          </span>
        </div>
        
        <input
          type="range"
          min={0}
          max={100}
          value={sliderValue}
          onChange={(e) => setSliderValue(parseInt(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer credit-slider"
          style={{
            background: isDark 
              ? `linear-gradient(to right, ${activeTierIndex === 0 ? '#10B981' : '#8b5cf6'} ${sliderValue}%, #27272a ${sliderValue}%)`
              : `linear-gradient(to right, ${activeTierIndex === 0 ? '#10B981' : '#8b5cf6'} ${sliderValue}%, #e4e4e7 ${sliderValue}%)`,
          }}
        />
        
        {/* Tick marks */}
        <div className="relative flex justify-between pointer-events-none" style={{ marginTop: '4px' }}>
          <div className={`w-2 h-2 rounded-full ${sliderValue >= SLIDER_FREE ? 'bg-emerald-500' : (isDark ? 'bg-zinc-700' : 'bg-zinc-300')}`} />
          <div className={`w-2 h-2 rounded-full ${sliderValue >= SLIDER_PRO ? 'bg-violet-500' : (isDark ? 'bg-zinc-700' : 'bg-zinc-300')}`} />
          <div className={`w-2 h-2 rounded-full ${sliderValue >= SLIDER_ENTERPRISE ? 'bg-blue-500' : (isDark ? 'bg-zinc-700' : 'bg-zinc-300')}`} />
        </div>
      </div>
      
      {/* Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Selection */}
        <div className={`p-6 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-zinc-200 shadow-sm'}`}>
          <h4 className={`text-sm font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            Your Selection
          </h4>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Credits</span>
              <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {currentPricing.credits.toLocaleString()}
              </span>
            </div>
            {!currentPricing.isFree && (
              <div className="flex items-center justify-between">
                <span className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Price per credit</span>
                <span className={`text-sm font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  ${currentPricing.pricePerCredit.toFixed(4)}
                </span>
              </div>
            )}
            <div className={`pt-4 border-t ${isDark ? 'border-zinc-700' : 'border-zinc-200'}`}>
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-zinc-900'}`}>Total</span>
                <span className={`text-3xl font-bold ${
                  currentPricing.isFree 
                    ? 'text-emerald-500' 
                    : 'text-transparent bg-clip-text bg-gradient-to-r from-violet-500 to-purple-500'
                }`}>
                  {currentPricing.isFree ? 'Free' : `$${currentPricing.price.toFixed(2)}`}
                </span>
              </div>
            </div>
          </div>
        </div>
        
        {/* Content Estimate */}
        <div className={`p-6 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-zinc-200 shadow-sm'}`}>
          <h4 className={`text-sm font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            You can process
          </h4>
          <div className="grid grid-cols-3 gap-4">
            <div className={`text-center p-3 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
              <FileText className={`w-5 h-5 mx-auto mb-2 ${isDark ? 'text-violet-400' : 'text-violet-500'}`} />
              <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{contentEstimate.parsePages}</p>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>PDF pages</p>
            </div>
            <div className={`text-center p-3 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
              <Zap className={`w-5 h-5 mx-auto mb-2 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
              <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{contentEstimate.tokens}</p>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>HQCC tokens</p>
            </div>
            <div className={`text-center p-3 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
              <Search className={`w-5 h-5 mx-auto mb-2 ${isDark ? 'text-cyan-400' : 'text-cyan-500'}`} />
              <p className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>{contentEstimate.searches}</p>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>searches</p>
            </div>
          </div>
        </div>
      </div>
      
      {/* Purchase Button */}
      {variant === 'landing' ? (
        <Link
          href="/auth"
          className={`w-full py-4 rounded-xl text-base font-bold transition-all flex items-center justify-center gap-2 ${
            currentPricing.isFeatured || currentPricing.id === 'pro'
              ? 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-lg shadow-violet-500/25'
              : (isDark
                  ? 'bg-white text-zinc-900 hover:bg-zinc-200'
                  : 'bg-zinc-900 text-white hover:bg-zinc-800')
          }`}
        >
          <CreditCard className="w-5 h-5" />
          {currentPricing.isFree
            ? 'Get Started Free'
            : `Purchase ${currentPricing.credits.toLocaleString()} Credits for $${currentPricing.price.toFixed(2)}`}
          <ArrowRight className="w-5 h-5 ml-1" />
        </Link>
      ) : (
        <button
          onClick={handlePurchase}
          disabled={disabled || loading || currentPricing.isFree}
          className={`w-full py-4 rounded-xl text-base font-bold transition-all flex items-center justify-center gap-2 ${
            currentPricing.isFree
              ? (isDark ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' : 'bg-zinc-200 text-zinc-400 cursor-not-allowed')
              : currentPricing.isFeatured || currentPricing.id === 'pro'
                ? 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-lg shadow-violet-500/25'
                : (isDark
                    ? 'bg-white text-zinc-900 hover:bg-zinc-200'
                    : 'bg-zinc-900 text-white hover:bg-zinc-800')
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {loading ? (
            <>
              <span className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Processing...
            </>
          ) : currentPricing.isFree ? (
            <>
              <Gift className="w-5 h-5" />
              Free credits already included
            </>
          ) : (
            <>
              <CreditCard className="w-5 h-5" />
              Purchase {currentPricing.credits.toLocaleString()} Credits for ${currentPricing.price.toFixed(2)}
              <ArrowRight className="w-5 h-5 ml-1" />
            </>
          )}
        </button>
      )}
      
      <p className={`text-xs text-center ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
        One-time purchase • Credits never expire • Secured by Stripe
      </p>
      
    </div>
  );
}
