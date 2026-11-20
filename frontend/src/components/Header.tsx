import type { ChangeEvent } from "react";
import type { QuestionCategory } from "../types/trivia";
import { AuthControls } from "./AuthControls";

interface HeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  category: QuestionCategory | "all";
  onCategoryChange: (value: QuestionCategory | "all") => void;
}

/** Top bar with the app title, a search box, and a category filter (F1). */
export function Header({ search, onSearchChange, category, onCategoryChange }: HeaderProps) {
  const handleSearch = (e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value);
  const handleCategory = (e: ChangeEvent<HTMLSelectElement>) =>
    onCategoryChange(e.target.value as QuestionCategory | "all");

  return (
    <header className="app-header">
      <div className="app-header__brand">
        Trivia<span className="app-header__brand-accent">Nerd</span>
      </div>
      <div className="app-header__search-group">
        <input
          type="search"
          className="app-header__search"
          placeholder="Simpsons Trivia"
          aria-label="Search questions"
          value={search}
          onChange={handleSearch}
        />
        <label className="sr-only" htmlFor="category-filter">
          Filter by category
        </label>
        <select
          id="category-filter"
          className="app-header__filter"
          value={category}
          onChange={handleCategory}
        >
          <option value="all">All categories</option>
          <option value="character">Character</option>
          <option value="episode">Episode</option>
          <option value="location">Location</option>
        </select>
      </div>
      <AuthControls />
    </header>
  );
}
