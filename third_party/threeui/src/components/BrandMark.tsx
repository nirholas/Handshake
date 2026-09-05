const TRIWAVE_TOP = "M36 178C112 252 184 264 260 196C336 128 404 114 482 180";
const TRIWAVE_BOTTOM = "M36 292C112 366 184 378 260 310C336 242 404 228 482 294";

const THREEUI_WORDMARK =
  "M214 1061H59V857H209V300C209 83 296-6 560-6C613-6 660-1 680 3V198C668 197 646 196 624 196C515 196 470 228 470 334V857H676V1061H470V1315H214ZM835 0H1098V622C1098 756 1173 854 1309 854C1424 854 1517 789 1517 626V0H1780V683C1780 943 1627 1078 1413 1078C1237 1078 1143 979 1109 906H1098V1437H835ZM1967 0H2236V605C2236 747 2296 851 2469 851C2510 851 2552 848 2573 842V1070C2552 1074 2525 1077 2489 1077C2344 1077 2265 983 2241 915H2230V1061H1967ZM3114-19C3398-19 3536 150 3561 320H3317C3295 234 3221 182 3116 182C2982 182 2891 284 2891 445V474H3571V578C3571 883 3392 1080 3103 1080C2824 1080 2633 896 2633 585V488C2633 163 2823-19 3114-19ZM2891 641V643C2891 779 2976 884 3105 884C3233 884 3316 780 3316 643V641ZM4165-19C4449-19 4587 150 4612 320H4368C4346 234 4272 182 4167 182C4033 182 3942 284 3942 445V474H4622V578C4622 883 4443 1080 4154 1080C3875 1080 3684 896 3684 585V488C3684 163 3874-19 4165-19ZM3942 641V643C3942 779 4027 884 4156 884C4284 884 4367 780 4367 643V641ZM5704 1061H5440V433C5440 284 5350 207 5232 207C5128 207 5029 255 5029 430V1061H4766V360C4766 110 4912-16 5129-16C5304-16 5402 72 5435 155H5447V0H5704ZM5915 0H6178V1061H5915Z";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  const maskId = compact ? "threeui-mark-compact" : "threeui-mark";

  return (
    <span className={compact ? "topbar-brand" : "logo"}>
      <span className="brand-symbol">
        <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
              <rect width="512" height="512" fill="#000" />
              <circle cx="256" cy="256" r="208" fill="#fff" />
              <g fill="none" stroke="#000" strokeLinecap="round" strokeWidth="28">
                <path d={TRIWAVE_TOP} />
                <path d={TRIWAVE_BOTTOM} />
              </g>
            </mask>
          </defs>
          <rect width="512" height="512" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
      </span>
      <svg className="brand-wordmark" viewBox="0 0 6319 1482" aria-hidden="true">
        <g transform="translate(0 1463) scale(1 -1)" fill="currentColor">
          <path d={THREEUI_WORDMARK} />
          <circle cx="6046" cy="1324" r="139" />
        </g>
      </svg>
    </span>
  );
}
