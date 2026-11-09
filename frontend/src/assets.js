import { createContext } from 'react';

// Оформление, которое задаёт админ: свой логотип и монета (адреса картинок или null).
export const AssetsContext = createContext({ logoUrl: null, coinUrl: null });
