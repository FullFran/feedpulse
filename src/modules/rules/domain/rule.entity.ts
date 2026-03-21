export interface Rule {
  id: number;
  name: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
